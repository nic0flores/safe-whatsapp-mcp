import test from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { SqliteAuthState } from "../dist/auth/sqliteAuthState.js";
import { SqliteState } from "../dist/storage/database.js";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { directMessage, runtimeConfig } from "./core-helpers.mjs";
import { temporaryState } from "./core-helpers.mjs";

test("SQLite auth round-trips credentials and every Baileys Signal key category", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true, routingInfo: Buffer.from([1, 2, 3]) });
    const appState = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from([9, 8, 7]),
      fingerprint: { rawId: 1, currentIndex: 2, deviceIndexes: [3] },
      timestamp: 4,
    });
    await auth.state.keys.set({
      "pre-key": { one: { public: Buffer.from([1]), private: Buffer.from([2]) } },
      session: { one: Buffer.from([3]) },
      "sender-key": { one: Buffer.from([4]) },
      "sender-key-memory": { one: { "a@s.whatsapp.net": true } },
      "app-state-sync-key": { one: appState },
      "app-state-sync-version": { one: { version: 1, hash: Buffer.from([5]), indexValueMap: {} } },
      "lid-mapping": { one: "9199@s.whatsapp.net" },
      "device-list": { one: ["1", "2"] },
      tctoken: { one: { token: Buffer.from([6]), timestamp: "7" } },
    });

    const reloaded = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    assert.equal(reloaded.state.creds.registered, true);
    assert.deepEqual(Buffer.from(reloaded.state.creds.routingInfo), Buffer.from([1, 2, 3]));
    for (const category of [
      "pre-key", "session", "sender-key", "sender-key-memory", "app-state-sync-key",
      "app-state-sync-version", "lid-mapping", "device-list", "tctoken",
    ]) {
      const values = await reloaded.state.keys.get(category, ["one"]);
      assert.ok(values.one, `${category} should round-trip`);
    }
    const hydrated = (await reloaded.state.keys.get("app-state-sync-key", ["one"])).one;
    assert.ok(hydrated instanceof proto.Message.AppStateSyncKeyData);
    await reloaded.state.keys.set({ session: { one: null } });
    assert.deepEqual(await reloaded.state.keys.get("session", ["one"]), {});
    assert.equal(reloaded.isPaired(), true);
  } finally {
    await fixture.cleanup();
  }
});

test("QR-paired identity remains paired when Baileys leaves registered false", async () => {
  const fixture = await temporaryState();
  let auth;
  let reloaded;
  try {
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({
      registered: false,
      me: { id: "919999999999:1@s.whatsapp.net", name: "QR Account" },
    });
    assert.equal(auth.isPaired(), false);

    await auth.saveCreds({
      account: proto.ADVSignedDeviceIdentity.fromObject({
        details: Buffer.from([1]),
        accountSignatureKey: Buffer.from([2]),
        accountSignature: Buffer.from([3]),
        deviceSignature: Buffer.from([4]),
      }),
    });
    assert.equal(auth.state.creds.registered, false);
    assert.equal(auth.isPaired(), true);
    await auth.close();
    auth = undefined;

    reloaded = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    assert.equal(reloaded.state.creds.registered, false);
    assert.equal(reloaded.isPaired(), true);
  } finally {
    await reloaded?.close().catch(() => undefined);
    await auth?.close().catch(() => undefined);
    await fixture.cleanup();
  }
});

test("schema v8 scrubs legacy raw payloads and adds durable tombstones", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const store = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      { ...runtimeConfig, retentionMs: 1_000 },
      () => now,
    );
    store.ingestHistory({
      chats: [{
        id: "919999999999@s.whatsapp.net",
        conversationTimestamp: Math.floor(Date.now() / 1_000),
        messages: [{ secret: "chat-history-secret" }],
      }],
      contacts: [],
      messages: [directMessage({
        id: "pruned",
        text: "pruned-message",
        timestamp: (now - 5_000) / 1_000,
      })],
    });
    assert.equal(
      fixture.state.db.prepare("SELECT raw_json FROM chats LIMIT 1").get().raw_json,
      null,
    );
    assert.equal(fixture.state.counts().messages, 0);
    store.ingestUpsert({
      messages: [directMessage({ id: "legacy", text: "legacy-message", timestamp: now / 1_000 })],
      type: "append",
    });
    fixture.state.db.prepare("UPDATE chats SET raw_json = ?").run('{"secret":"legacy-chat"}');
    fixture.state.db.prepare("UPDATE messages SET raw_json = ?").run('{"secret":"legacy-quote"}');
    fixture.state.db.pragma("user_version = 1");
    fixture.state.close();

    const migrated = await SqliteState.open(fixture.paths);
    try {
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 8);
      assert.equal(migrated.db.prepare("SELECT raw_json FROM chats LIMIT 1").get().raw_json, null);
      assert.equal(migrated.db.prepare("SELECT raw_json FROM messages LIMIT 1").get().raw_json, null);
      assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name = 'message_tombstones'").get());
      assert.ok(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_clear_tombstones'").get());
    } finally {
      migrated.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("schema v8 scrubs unsafe raw envelopes from existing v4 profiles", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.ingestUpsert({
      messages: [directMessage({ id: "legacy-v4", text: "legacy" })],
      type: "append",
    });
    fixture.state.db.prepare("UPDATE chats SET raw_json = ?").run('{"secret":"legacy-chat"}');
    fixture.state.db.prepare("UPDATE messages SET raw_json = ?").run(
      '{"message":{"imageMessage":{"url":"https://127.0.0.1/private"}}}',
    );
    fixture.state.db.pragma("user_version = 4");
    fixture.state.close();

    const migrated = await SqliteState.open(fixture.paths);
    try {
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 8);
      assert.equal(migrated.db.prepare("SELECT raw_json FROM chats LIMIT 1").get().raw_json, null);
      assert.equal(migrated.db.prepare("SELECT raw_json FROM messages LIMIT 1").get().raw_json, null);
    } finally {
      migrated.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("schema v8 removes legacy persisted group participant metadata", async () => {
  const fixture = await temporaryState();
  try {
    fixture.state.db.prepare(
      "INSERT INTO groups (transport_jid, metadata_json, updated_at) VALUES (?, ?, ?)",
    ).run(
      "100000000000@g.us",
      '{"subject":"Private","participants":[{"id":"919999999999@s.whatsapp.net"}]}',
      Date.now(),
    );
    fixture.state.db.pragma("user_version = 5");
    fixture.state.close();

    const migrated = await SqliteState.open(fixture.paths);
    try {
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 8);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM groups").get().count, 0);
    } finally {
      migrated.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("schema v8 treats pre-migration source timestamps as unknown", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.ingestUpsert({
      messages: [directMessage({ id: "legacy-source-time", text: "legacy" })],
      type: "append",
    });
    assert.equal(
      fixture.state.db.prepare("SELECT source_timestamp_valid FROM messages").get().source_timestamp_valid,
      1,
    );
    fixture.state.db.exec("ALTER TABLE messages DROP COLUMN source_timestamp_valid");
    fixture.state.db.pragma("user_version = 6");
    fixture.state.close();

    const migrated = await SqliteState.open(fixture.paths);
    try {
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 8);
      assert.equal(
        migrated.db.prepare("SELECT source_timestamp_valid FROM messages").get().source_timestamp_valid,
        0,
      );
    } finally {
      migrated.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
