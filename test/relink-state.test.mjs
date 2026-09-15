import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAuthState } from "../dist/auth/sqliteAuthState.js";
import {
  clearAuthenticationStatePreservingCache,
  ensureStateOwnership,
} from "../dist/storage/accountState.js";
import { SqliteState } from "../dist/storage/database.js";
import { StatePaths } from "../dist/storage/paths.js";
import { MemoryMasterKeyStore } from "./core-helpers.mjs";

test("same-account relink clears only auth rows and preserves cached chat state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-relink-"));
  const paths = new StatePaths(root);
  const keyStore = new MemoryMasterKeyStore();
  await ensureStateOwnership(paths);
  const state = await SqliteState.open(paths);
  const auth = await SqliteAuthState.open(state, keyStore);
  const now = Date.now();
  try {
    await auth.saveCreds({
      registered: true,
      me: { id: "919999999999:1@s.whatsapp.net", name: "Same Account" },
    });
    await auth.state.keys.set({ session: { old: Buffer.from([1, 2, 3]) } });
    state.db.transaction(() => {
      state.db.prepare(
        "INSERT INTO identities (id, e164, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("identity-1", "+919999999999", "cipher-name", now, now);
      state.db.prepare(
        "INSERT INTO chats (id, transport_jid, kind, identity_id, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("chat-1", "919999999999@s.whatsapp.net", "direct", "identity-1", null, now);
      state.db.prepare(`
        INSERT INTO messages (
          id, chat_id, source_id, transport_chat_jid, from_me, timestamp,
          text, view_once, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "message-1",
        "chat-1",
        "source-1",
        "919999999999@s.whatsapp.net",
        0,
        now,
        "cipher-text",
        0,
        now,
        now,
      );
      state.db.prepare("INSERT INTO local_meta (key, value) VALUES (?, ?)")
        .run("encrypted_cache_epoch", "1");
    })();

    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM auth_credentials").get().count, 1);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM auth_keys").get().count, 1);
    assert.deepEqual(state.counts(), { chats: 1, messages: 1, identities: 1 });

    await auth.quiesceCredentialState();
    await clearAuthenticationStatePreservingCache(state);

    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM auth_credentials").get().count, 0);
    assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM auth_keys").get().count, 0);
    assert.deepEqual(state.counts(), { chats: 1, messages: 1, identities: 1 });
    assert.deepEqual(
      state.db.prepare("SELECT key, value FROM local_meta ORDER BY key").all(),
      [{ key: "encrypted_cache_epoch", value: "1" }],
    );
    await fs.access(paths.credentialVaultFile);
  } finally {
    await auth.close().catch(() => undefined);
    state.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
