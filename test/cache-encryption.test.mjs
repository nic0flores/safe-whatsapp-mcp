import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { CacheRecordCipher } from "../dist/security/cacheRecordCipher.js";
import { CacheVault } from "../dist/security/cacheVault.js";
import { DirectChatAllowlist } from "../dist/security/chatAllowlist.js";
import { HardenedMessageStore } from "../dist/security/hardenedMessageStore.js";
import { initializeEncryptedCacheEpoch } from "../dist/security/persistencePrivacy.js";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import {
  directMessage,
  runtimeConfig,
  temporaryState,
} from "./core-helpers.mjs";

const ALLOWED_E164 = "+56911111111";
const ALLOWED_JID = "56911111111@s.whatsapp.net";
const NAME_CANARY = "CACHE_NAME_CANARY_7QJ9";
const CHAT_CANARY = "CACHE_CHAT_CANARY_8XK2";
const TEXT_CANARY = "CACHE_TEXT_CANARY_SECRET_9ZL3";
const CAPTION_CANARY = "CACHE_CAPTION_CANARY_SECRET_4PM6";
const FILE_CANARY = "CACHE_FILENAME_CANARY_5RN7.pdf";
const LEGACY_CANARY = "PLAINTEXT_LEGACY_CANARY_K2V8Y4Q9";

function allowlist() {
  return DirectChatAllowlist.fromEnvironment({
    SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164: ALLOWED_E164,
  });
}

test("cache record cipher uses fresh nonces and AAD-bound authenticated ciphertext", () => {
  const key = Buffer.alloc(32, 0x42);
  const cipher = new CacheRecordCipher(key, "11111111-1111-4111-8111-111111111111");
  try {
    const first = cipher.encrypt("private message", "message_text:m1");
    const second = cipher.encrypt("private message", "message_text:m1");
    assert.notEqual(first, second);
    assert.equal(cipher.decrypt(first, "message_text:m1"), "private message");
    assert.throws(
      () => cipher.decrypt(first, "message_text:m2"),
      (error) => error.code === "cache_ciphertext_invalid",
    );
    const envelope = JSON.parse(first);
    envelope.c = envelope.c.slice(0, -1) + (envelope.c.endsWith("A") ? "B" : "A");
    assert.throws(
      () => cipher.decrypt(JSON.stringify(envelope), "message_text:m1"),
      (error) => error.code === "cache_ciphertext_invalid",
    );
  } finally {
    cipher.destroy();
    key.fill(0);
  }
});

test("hardened cache stores human content encrypted while reads and scoped search return plaintext", async () => {
  const fixture = await temporaryState();
  let vault;
  try {
    initializeEncryptedCacheEpoch(fixture.state);
    vault = await CacheVault.open(fixture.paths.cacheVaultFile, fixture.masterKeyStore, false);
    const identities = new IdentityStore(fixture.state, vault);
    const store = new HardenedMessageStore(
      fixture.state,
      identities,
      runtimeConfig,
      allowlist(),
      vault,
    );
    const now = Math.floor(Date.now() / 1_000);
    store.ingestHistory({
      contacts: [{ id: ALLOWED_JID, notify: NAME_CANARY }],
      chats: [{ id: ALLOWED_JID, name: CHAT_CANARY }],
      messages: [
        directMessage({
          id: "encrypted-text-1",
          jid: ALLOWED_JID,
          text: TEXT_CANARY,
          timestamp: now,
        }),
        directMessage({
          id: "encrypted-doc-1",
          jid: ALLOWED_JID,
          timestamp: now + 1,
          message: {
            documentMessage: {
              caption: CAPTION_CANARY,
              fileName: FILE_CANARY,
              mimetype: "application/pdf",
              fileLength: 123,
              directPath: "/private/media/path",
              mediaKey: Buffer.alloc(32, 7),
            },
          },
        }),
      ],
    });

    const identityRow = fixture.state.db.prepare(
      "SELECT display_name FROM identities WHERE e164 = ?",
    ).get(ALLOWED_E164);
    assert.ok(identityRow.display_name);
    assert.equal(identityRow.display_name.includes(NAME_CANARY), false);
    assert.equal(identityRow.display_name.includes(CHAT_CANARY), false);

    const chatRow = fixture.state.db.prepare(
      "SELECT id, title FROM chats WHERE transport_jid = ?",
    ).get(ALLOWED_JID);
    assert.equal(chatRow.title, null);

    const rows = fixture.state.db.prepare(`
      SELECT source_id, text, media_filename, raw_json
      FROM messages ORDER BY source_id
    `).all();
    const serialized = JSON.stringify(rows);
    for (const canary of [NAME_CANARY, CHAT_CANARY, TEXT_CANARY, CAPTION_CANARY, FILE_CANARY]) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked into SQLite rows`);
    }
    assert.equal(serialized.includes("/private/media/path"), false);
    assert.equal(serialized.includes(Buffer.alloc(32, 7).toString("base64")), false);

    const chat = store.listChats({ limit: 10 }).items[0];
    assert.equal(chat.title, CHAT_CANARY);
    assert.equal(chat.latestSnippet, CAPTION_CANARY);

    const read = store.readChat({ chatId: chatRow.id, limit: 10 }).items;
    assert.equal(read.find((message) => message.sourceId === "encrypted-text-1").text, TEXT_CANARY);
    const document = read.find((message) => message.sourceId === "encrypted-doc-1");
    assert.equal(document.text, CAPTION_CANARY);
    assert.equal(document.media.filename, FILE_CANARY);

    const search = store.searchMessages({
      query: "text_canary_secret",
      chatId: chatRow.id,
      limit: 10,
    });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0].text, TEXT_CANARY);

    vault.dispose();
    vault = await CacheVault.open(fixture.paths.cacheVaultFile, fixture.masterKeyStore, true);
    const reopenedStore = new HardenedMessageStore(
      fixture.state,
      new IdentityStore(fixture.state, vault),
      runtimeConfig,
      allowlist(),
      vault,
    );
    assert.equal(
      reopenedStore.readChat({ chatId: chatRow.id, limit: 10 }).items
        .find((message) => message.sourceId === "encrypted-text-1").text,
      TEXT_CANARY,
    );
  } finally {
    vault?.dispose();
    await fixture.cleanup();
  }
});

test("encrypted cache refuses to open when its independent OS key is missing", async () => {
  const fixture = await temporaryState();
  let vault;
  try {
    initializeEncryptedCacheEpoch(fixture.state);
    vault = await CacheVault.open(fixture.paths.cacheVaultFile, fixture.masterKeyStore, false);
    const store = new HardenedMessageStore(
      fixture.state,
      new IdentityStore(fixture.state, vault),
      runtimeConfig,
      allowlist(),
      vault,
    );
    store.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "missing-key-1", jid: ALLOWED_JID, text: TEXT_CANARY })],
    });
    vault.dispose();
    vault = undefined;
    fixture.masterKeyStore.keys.clear();
    await assert.rejects(
      CacheVault.open(fixture.paths.cacheVaultFile, fixture.masterKeyStore, true),
      (error) => error.code === "cache_key_missing",
    );
  } finally {
    vault?.dispose();
    await fixture.cleanup();
  }
});

test("encrypted cache epoch removes legacy plaintext from logical rows and vacuumed database pages", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const legacy = new MessageStore(fixture.state, identities, runtimeConfig);
    legacy.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "legacy-plaintext-1", jid: ALLOWED_JID, text: LEGACY_CANARY })],
    });
    fixture.state.db.exec("CREATE TABLE future_private_cache (value TEXT NOT NULL)");
    fixture.state.db.prepare("INSERT INTO future_private_cache (value) VALUES (?)").run(`${LEGACY_CANARY}-future`);
    fixture.state.db.pragma("wal_checkpoint(TRUNCATE)");
    assert.equal((await fs.readFile(fixture.paths.databaseFile)).includes(Buffer.from(LEGACY_CANARY)), true);

    assert.equal(initializeEncryptedCacheEpoch(fixture.state), true);
    assert.deepEqual(fixture.state.counts(), { chats: 0, messages: 0, identities: 0 });
    assert.equal(
      fixture.state.db.prepare("SELECT COUNT(*) AS count FROM future_private_cache").get().count,
      0,
    );
    fixture.state.db.pragma("wal_checkpoint(TRUNCATE)");
    assert.equal((await fs.readFile(fixture.paths.databaseFile)).includes(Buffer.from(LEGACY_CANARY)), false);
    assert.deepEqual(
      fixture.state.db.prepare("SELECT key, value FROM local_meta").all(),
      [{ key: "encrypted_cache_epoch", value: "1" }],
    );
  } finally {
    await fixture.cleanup();
  }
});
