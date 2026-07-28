import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SafeWhatsAppApplication } from "../dist/application.js";
import { SqliteAuthState } from "../dist/auth/sqliteAuthState.js";
import { ensureStateOwnership } from "../dist/storage/accountState.js";
import { SqliteState } from "../dist/storage/database.js";
import { StatePaths } from "../dist/storage/paths.js";
import { WhatsAppCore } from "../dist/whatsapp/core.js";
import { MemoryMasterKeyStore } from "./core-helpers.mjs";

test("unpaired connect cleanup runs before fresh auth hydration and preserves config/outbox", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-account-connect-"));
  const paths = new StatePaths(root);
  const masterKeyStore = new MemoryMasterKeyStore();
  let initial = await SafeWhatsAppApplication.open({ paths, masterKeyStore });
  await initial.close();

  const state = await SqliteState.open(paths);
  await seedEveryAccountTable(state, false, masterKeyStore);
  state.close();
  await Promise.all([
    fs.writeFile(paths.configFile, "{}\n"),
    fs.writeFile(path.join(paths.outboxDir, "keep.txt"), "user-owned"),
    fs.writeFile(path.join(paths.pendingDir, "11111111-1111-4111-8111-111111111111.json"), "not json"),
    fs.writeFile(path.join(paths.mediaDir, "old.bin"), "old media"),
    fs.writeFile(paths.auditFile, "old audit"),
    fs.writeFile(`${paths.auditFile}.1.22222222-2222-4222-8222-222222222222.tmp`, "old temp"),
    fs.writeFile(`${paths.auditFile}.notes.tmp`, "not package-owned"),
  ]);

  try {
    initial = await SafeWhatsAppApplication.open({
      paths,
      clearResidualIfUnpaired: true,
      masterKeyStore,
    });
    assert.equal(initial.core.auth.state.creds.registered, false);
    assert.equal(initial.core.auth.state.creds.me, undefined);
    assertAllApplicationTablesEmpty(initial.core.state);
    assert.equal(await fs.readFile(paths.configFile, "utf8"), "{}\n");
    assert.equal(await fs.readFile(path.join(paths.outboxDir, "keep.txt"), "utf8"), "user-owned");
    await fs.access(paths.ownershipMarker);
    await assert.rejects(fs.access(path.join(paths.pendingDir, "11111111-1111-4111-8111-111111111111.json")));
    await assert.rejects(fs.access(path.join(paths.mediaDir, "old.bin")));
    await assert.rejects(fs.access(paths.auditFile));
    await assert.rejects(fs.access(`${paths.auditFile}.1.22222222-2222-4222-8222-222222222222.tmp`));
    assert.equal(await fs.readFile(`${paths.auditFile}.notes.tmp`, "utf8"), "not package-owned");
    assert.equal(masterKeyStore.keys.size, 0);
    await assert.rejects(fs.access(paths.credentialVaultFile));
  } finally {
    await initial.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("connect cleanup preserves QR-paired credentials and account state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-account-qr-paired-"));
  const paths = new StatePaths(root);
  const masterKeyStore = new MemoryMasterKeyStore();
  await ensureStateOwnership(paths);
  const state = await SqliteState.open(paths);
  await seedEveryAccountTable(state, false, masterKeyStore, qrAccountIdentity());
  state.close();

  let application;
  try {
    application = await SafeWhatsAppApplication.open({
      paths,
      clearResidualIfUnpaired: true,
      masterKeyStore,
    });
    assert.equal(application.core.auth.state.creds.registered, false);
    assert.equal(application.core.auth.isPaired(), true);
    assert.deepEqual(application.core.state.counts(), { chats: 1, messages: 1, identities: 1 });
    assert.equal(
      application.core.state.db.prepare("SELECT COUNT(*) AS count FROM auth_keys").get().count,
      1,
    );
    assert.equal(
      application.core.state.db.prepare("SELECT COUNT(*) AS count FROM future_account_state").get().count,
      1,
    );
    assert.equal(masterKeyStore.keys.size, 1);
    await fs.access(paths.credentialVaultFile);
  } finally {
    await application?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed remote unlink still clears account state and reports an unconfirmed logout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-account-unlink-"));
  const paths = new StatePaths(root);
  await ensureStateOwnership(paths);
  const state = await SqliteState.open(paths);
  const masterKeyStore = new MemoryMasterKeyStore();
  await seedEveryAccountTable(state, true, masterKeyStore);
  const auth = await SqliteAuthState.open(state, masterKeyStore);
  await Promise.all([
    fs.writeFile(paths.configFile, "{\"retentionDays\":1}\n"),
    fs.writeFile(path.join(paths.outboxDir, "keep.txt"), "keep"),
    fs.writeFile(path.join(paths.pendingDir, "draft"), "draft"),
    fs.writeFile(path.join(paths.mediaDir, "download"), "download"),
    fs.writeFile(paths.auditFile, "audit"),
    fs.writeFile(`${paths.databaseFile}-journal`, "prior account pages"),
  ]);
  const calls = [];
  const client = {
    status: () => ({ paired: true }),
    unlinkRemote: async () => { calls.push("logout"); throw new Error("network detail"); },
    disconnect: async () => { calls.push("disconnect"); },
  };
  const core = new WhatsAppCore(
    state,
    auth,
    {},
    {},
    client,
    { release: async () => calls.push("release") },
  );
  try {
    assert.deepEqual(await core.unlink(), { wasPaired: true, remoteLogout: "unconfirmed" });
    assert.deepEqual(calls, ["logout", "disconnect"]);
    assert.equal(auth.isPaired(), false);
    assert.equal(auth.state.creds.me, undefined);
    assertAllApplicationTablesEmpty(state);
    assert.equal(await fs.readFile(paths.configFile, "utf8"), "{\"retentionDays\":1}\n");
    assert.equal(await fs.readFile(path.join(paths.outboxDir, "keep.txt"), "utf8"), "keep");
    assert.equal(masterKeyStore.keys.size, 0);
    await assert.rejects(fs.access(paths.credentialVaultFile));
    await assert.rejects(fs.access(path.join(paths.pendingDir, "draft")));
    await assert.rejects(fs.access(path.join(paths.mediaDir, "download")));
    await assert.rejects(fs.access(paths.auditFile));
    await assert.rejects(fs.access(`${paths.databaseFile}-journal`));
  } finally {
    await core.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("successful logout transport is reported as requested rather than server-confirmed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-account-unlink-request-"));
  const paths = new StatePaths(root);
  await ensureStateOwnership(paths);
  const state = await SqliteState.open(paths);
  const masterKeyStore = new MemoryMasterKeyStore();
  await seedEveryAccountTable(state, true, masterKeyStore);
  const auth = await SqliteAuthState.open(state, masterKeyStore);
  const calls = [];
  const core = new WhatsAppCore(
    state,
    auth,
    {},
    {},
    {
      status: () => ({ paired: true }),
      unlinkRemote: async () => { calls.push("logout"); },
      disconnect: async () => undefined,
    },
    { release: async () => undefined },
  );
  try {
    assert.deepEqual(await core.unlink(), { wasPaired: true, remoteLogout: "requested" });
    assert.deepEqual(calls, ["logout"]);
    assert.equal(auth.isPaired(), false);
    assert.equal(masterKeyStore.keys.size, 0);
  } finally {
    await core.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function seedEveryAccountTable(state, registered, masterKeyStore, account) {
  const now = Date.now();
  const auth = await SqliteAuthState.open(state, masterKeyStore);
  await auth.saveCreds({
    registered,
    me: { id: "919999999999:1@s.whatsapp.net", name: "Old Account" },
    ...(account ? { account } : {}),
  });
  await auth.state.keys.set({ session: { old: Buffer.from([1, 2, 3]) } });
  state.db.transaction(() => {
    state.db.prepare("INSERT INTO identities (id, e164, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("identity-old", "+919999999999", "Old Contact", now, now);
    state.db.prepare("INSERT INTO identity_aliases (jid, identity_id, kind, last_seen_at) VALUES (?, ?, ?, ?)")
      .run("919999999999@s.whatsapp.net", "identity-old", "pn", now);
    state.db.prepare("INSERT INTO chats (id, transport_jid, kind, identity_id, title, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("chat-old", "919999999999@s.whatsapp.net", "direct", "identity-old", "Old Chat", now);
    state.db.prepare(`
      INSERT INTO messages (
        id, chat_id, source_id, transport_chat_jid, from_me, timestamp,
        text, view_once, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("message-old", "chat-old", "source-old", "919999999999@s.whatsapp.net", 0, now, "old", 0, now, now);
    state.db.prepare("INSERT INTO message_tombstones (transport_chat_jid, source_id, deleted_at) VALUES (?, ?, ?)")
      .run("919999999999@s.whatsapp.net", "deleted-old", now);
    state.db.prepare("INSERT INTO chat_clear_tombstones (transport_chat_jid, cleared_at) VALUES (?, ?)")
      .run("120363000000000000@g.us", now);
    state.db.prepare("INSERT INTO groups (transport_jid, metadata_json, updated_at) VALUES (?, ?, ?)")
      .run("120363000000000000@g.us", "{}", now);
    state.db.prepare("INSERT INTO local_meta (key, value) VALUES (?, ?)").run("last_sync_at", `${now}`);
    state.db.exec("CREATE TABLE IF NOT EXISTS future_account_state (value TEXT NOT NULL)");
    state.db.prepare("INSERT INTO future_account_state (value) VALUES (?)").run("future private data");
  })();
  await auth.close();
}

function qrAccountIdentity() {
  return {
    details: Buffer.from([1]),
    accountSignatureKey: Buffer.from([2]),
    accountSignature: Buffer.from([3]),
    deviceSignature: Buffer.from([4]),
  };
}

function assertAllApplicationTablesEmpty(state) {
  const tables = state.db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const row = state.db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get();
    assert.equal(row.count, 0, `${name} should be empty`);
  }
}
