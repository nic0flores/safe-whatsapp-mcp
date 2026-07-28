import test from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { e164FromPhoneJid, IdentityStore, normalizeUserJid } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { parseMessage } from "../dist/messages/messageParser.js";
import { directMessage, runtimeConfig, temporaryState } from "./core-helpers.mjs";

test("PN and LID aliases deterministically converge on the E.164-owning identity", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const lid = identities.observe({ jid: "777777777777777@lid" });
    const pn = identities.observe({ jid: "919999999999@s.whatsapp.net" });
    assert.notEqual(lid.id, pn.id);
    const linked = identities.linkLid("777777777777777@lid", "919999999999:4@s.whatsapp.net");
    assert.equal(linked.id, pn.id);
    assert.equal(linked.e164, "+919999999999");
    assert.deepEqual(
      linked.aliases.map((alias) => alias.jid).sort(),
      ["777777777777777@lid", "919999999999@s.whatsapp.net"],
    );
    assert.equal(fixture.state.counts().identities, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("only canonical phone JIDs become structured E.164 identities", async () => {
  assert.equal(e164FromPhoneJid("919999999999@s.whatsapp.net"), "+919999999999");
  for (const jid of [
    "01234567@s.whatsapp.net",
    "123456@s.whatsapp.net",
    "1234567890123456@s.whatsapp.net",
  ]) assert.equal(e164FromPhoneJid(jid), undefined);

  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    assert.equal(identities.observe({ jid: "01234567@s.whatsapp.net" }).e164, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("contact phoneNumber metadata resolves a LID contact to E.164", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const store = new MessageStore(fixture.state, identities, runtimeConfig);
    store.upsertContacts([{
      id: "777777777777777@lid",
      phoneNumber: "919999999999@s.whatsapp.net",
      notify: "Structured contact name",
    }]);
    assert.equal(identities.findByJid("777777777777777@lid").e164, "+919999999999");
  } finally {
    await fixture.cleanup();
  }
});

test("structured alias mappings reject oversized, malformed, and same-kind JIDs", async () => {
  assert.throws(
    () => normalizeUserJid(`${"9".repeat(200)}@s.whatsapp.net`),
    (error) => error.code === "invalid_identity",
  );
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.ingestHistory({
      chats: [],
      contacts: [],
      messages: [],
      lidPnMappings: [
        { lid: `${"7".repeat(200)}@lid`, pn: "919999999999@s.whatsapp.net" },
        { lid: "777777777777777@lid", pn: `${"9".repeat(200)}@s.whatsapp.net` },
        { lid: "777777777777777@lid", pn: "888888888888888@lid" },
        { lid: null, pn: "919999999999@s.whatsapp.net" },
      ],
    });
    store.linkUserAliases("777777777777777@lid", "888888888888888@lid");
    assert.equal(fixture.state.counts().identities, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("message alternates cannot merge two phone identities in direct or group chats", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const store = new MessageStore(fixture.state, identities, runtimeConfig);
    const firstPhone = "919999999999@s.whatsapp.net";
    const secondPhone = "918888888888@s.whatsapp.net";
    const direct = directMessage({ id: "same-kind-direct", jid: firstPhone });
    direct.key.remoteJidAlt = secondPhone;
    const group = directMessage({ id: "same-kind-group", jid: "100000000000@g.us" });
    group.key.participant = firstPhone;
    group.key.participantAlt = secondPhone;
    store.ingestUpsert({ messages: [direct, group], type: "append" });

    assert.equal(identities.findByJid(firstPhone).e164, "+919999999999");
    assert.equal(identities.findByJid(secondPhone), undefined);
    const groupChat = store.listChats({ kind: "group" }).items[0];
    assert.equal(store.readChat({ chatId: groupChat.chatId }).items[0].senderE164, "+919999999999");
  } finally {
    await fixture.cleanup();
  }
});

test("history mappings precede messages and reverse/deduplicated chunks do not create edits", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const store = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      runtimeConfig,
      () => now,
    );
    const jid = "777777777777777@lid";
    const messages = [
      directMessage({ id: "a", jid, text: "first", timestamp: now / 1_000 }),
      directMessage({ id: "b", jid, text: "second", timestamp: now / 1_000 + 1 }),
    ];
    for (const message of messages) message.key.remoteJidAlt = "919999999999@s.whatsapp.net";
    store.ingestHistory({
      chats: [], contacts: [], messages: [...messages].reverse(),
      lidPnMappings: [{ lid: jid, pn: "919999999999@s.whatsapp.net" }],
    });
    store.ingestHistory({ chats: [], contacts: [], messages });
    const chat = store.listChats().items[0];
    assert.equal(chat.e164, "+919999999999");
    const read = store.readChat({ chatId: chat.chatId }).items;
    assert.equal(read.length, 2);
    assert.equal(read[0].text, "second");
    assert.equal(read[0].editedAt, undefined);
    assert.equal(read[1].editedAt, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit edit preserves ordering; revoke clears content; view-once is never exposed", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig, () => now);
    const original = directMessage({ id: "edit-me", text: "before", timestamp: now / 1_000 - 10 });
    store.ingestUpsert({ messages: [original], type: "notify" });
    const chat = store.listChats({ unreadOnly: true }).items[0];
    assert.equal(chat.unreadCount, 1);
    const originalTime = store.readChat({ chatId: chat.chatId }).items[0].timestamp;

    store.applyUpdates([{
      key: original.key,
      update: { message: { editedMessage: { message: { conversation: "after" } } } },
    }]);
    const edited = store.readChat({ chatId: chat.chatId }).items[0];
    assert.equal(edited.text, "after");
    assert.equal(edited.timestamp, originalTime);
    assert.ok(edited.editedAt);

    const viewOnce = directMessage({
      id: "secret",
      timestamp: now / 1_000,
      message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg", caption: "hidden" } } } },
    });
    store.ingestUpsert({ messages: [viewOnce], type: "notify" });
    assert.equal(store.readChat({ chatId: chat.chatId }).items.some((item) => item.sourceId === "secret"), false);

    store.applyUpdates([{
      key: original.key,
      update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
    }]);
    const revoked = store.readChat({ chatId: chat.chatId }).items.find((item) => item.sourceId === "edit-me");
    assert.equal(revoked.text, undefined);
    assert.ok(revoked.deletedAt);
    assert.equal(store.searchMessages({ query: "after" }).items.length, 0);
    assert.equal(store.getRetainedMessage(edited.messageId), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("retention removes expired records and enforces the per-chat cap", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const store = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      { retentionMs: 1_000, maxMessagesPerChat: 2 },
      () => now,
    );
    store.ingestUpsert({
      type: "append",
      messages: [
        directMessage({ id: "old", timestamp: (now - 2_000) / 1_000 }),
        directMessage({ id: "one", timestamp: (now - 300) / 1_000 }),
        directMessage({ id: "two", timestamp: (now - 200) / 1_000 }),
        directMessage({ id: "three", timestamp: (now - 100) / 1_000 }),
      ],
    });
    const chat = store.listChats().items[0];
    assert.deepEqual(store.readChat({ chatId: chat.chatId, limit: 200 }).items.map((item) => item.sourceId), ["three", "two"]);
  } finally {
    await fixture.cleanup();
  }
});

test("view-once nested beyond six wrappers and wrapper cycles fail closed", () => {
  let content = {
    viewOnceMessageV2: {
      message: { imageMessage: { mimetype: "image/jpeg", caption: "deep secret" } },
    },
  };
  for (let index = 0; index < 10; index += 1) {
    content = { ephemeralMessage: { message: content } };
  }
  const parsed = parseMessage(directMessage({ id: "deep-view-once", message: content }));
  assert.equal(parsed.viewOnce, true);
  assert.equal(parsed.rawJson, undefined);
  assert.equal(parsed.text, undefined);
  assert.equal(parsed.media, undefined);

  const cycle = {};
  cycle.ephemeralMessage = { message: cycle };
  const cyclic = parseMessage(directMessage({ id: "cycle", message: cycle }));
  assert.equal(cyclic.viewOnce, true);
  assert.equal(cyclic.rawJson, undefined);
});

test("quoted message bodies are stripped from retained raw data", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const secret = "ORIGINAL-SECRET-MUST-NOT-SURVIVE";
    const original = directMessage({ id: "original", text: secret });
    const quoting = directMessage({
      id: "quoting",
      message: {
        extendedTextMessage: {
          text: "safe reply text",
          contextInfo: {
            stanzaId: "original",
            participant: "919999999999@s.whatsapp.net",
            quotedMessage: { conversation: secret },
          },
        },
      },
    });
    store.ingestUpsert({ messages: [original, quoting], type: "append" });
    const chat = store.listChats().items[0];
    const quoteRecord = store.readChat({ chatId: chat.chatId }).items.find((item) => item.sourceId === "quoting");
    const raw = store.getRetainedMessage(quoteRecord.messageId).raw;
    assert.equal(quoteRecord.quotedSourceId, "original");
    assert.equal(raw.key.id, "quoting");
    assert.equal(raw.message.extendedTextMessage.contextInfo, undefined);

    store.applyDeletes({ keys: [original.key] });
    const rawRows = fixture.state.db.prepare("SELECT raw_json FROM messages WHERE raw_json IS NOT NULL").all();
    assert.equal(JSON.stringify(rawRows).includes(secret), false);
  } finally {
    await fixture.cleanup();
  }
});

test("deletion tombstones survive duplicate history and delete-before-message ordering", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const original = directMessage({ id: "revoked-then-replayed", text: "must stay deleted" });
    store.ingestUpsert({ messages: [original], type: "append" });
    store.applyDeletes({ keys: [original.key] });
    store.ingestHistory({ chats: [], contacts: [], messages: [original] });

    const future = directMessage({ id: "deleted-before-arrival", text: "must never appear" });
    store.applyDeletes({ keys: [future.key] });
    store.ingestUpsert({ messages: [future], type: "notify" });

    const rows = fixture.state.db.prepare(`
      SELECT source_id, text, media_kind, raw_json, deleted_at
      FROM messages WHERE source_id IN (?, ?) ORDER BY source_id
    `).all(original.key.id, future.key.id);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.text, null);
      assert.equal(row.media_kind, null);
      assert.equal(row.raw_json, null);
      assert.ok(row.deleted_at);
    }
    assert.equal(
      fixture.state.db.prepare("SELECT COUNT(*) AS count FROM message_tombstones").get().count,
      2,
    );
    const chat = store.listChats().items[0];
    const visible = store.readChat({ chatId: chat.chatId }).items;
    assert.equal(visible.every((message) => !message.text && message.deletedAt), true);
    assert.equal(chat.unreadCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("PN/LID-equivalent revokes and tombstones hide content in both directions", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const pn = "919999999999@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const onLid = directMessage({ id: "stored-on-lid", jid: lid, text: "delete from PN" });
    onLid.key.remoteJidAlt = pn;
    const onPn = directMessage({ id: "stored-on-pn", jid: pn, text: "delete from LID" });
    onPn.key.remoteJidAlt = lid;
    store.ingestUpsert({ messages: [onLid, onPn], type: "append" });

    store.applyDeletes({ keys: [
      { remoteJid: pn, id: "stored-on-lid" },
      { remoteJid: lid, id: "stored-on-pn" },
      { remoteJid: pn, remoteJidAlt: lid, id: "delete-before-alias-arrival" },
    ] });
    const future = directMessage({
      id: "delete-before-alias-arrival",
      jid: lid,
      text: "must remain hidden",
    });
    future.key.remoteJidAlt = pn;
    store.ingestUpsert({ messages: [future], type: "notify" });

    const rows = fixture.state.db.prepare(`
      SELECT source_id, text, deleted_at FROM messages
      WHERE source_id IN (?, ?, ?) ORDER BY source_id, transport_chat_jid
    `).all("stored-on-lid", "stored-on-pn", "delete-before-alias-arrival");
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.text, null);
      assert.ok(row.deleted_at);
    }
    const tombstones = fixture.state.db.prepare(`
      SELECT transport_chat_jid, source_id FROM message_tombstones
      WHERE source_id IN (?, ?, ?)
    `).all("stored-on-lid", "stored-on-pn", "delete-before-alias-arrival");
    for (const sourceId of ["stored-on-lid", "stored-on-pn", "delete-before-alias-arrival"]) {
      assert.deepEqual(
        tombstones.filter((row) => row.source_id === sourceId)
          .map((row) => row.transport_chat_jid).sort(),
        [lid, pn].sort(),
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("late PN/LID mapping propagates clears and alias-addressed edits update retained content", async () => {
  const fixture = await temporaryState();
  try {
    const clearAt = Date.now();
    let now = clearAt;
    const pn = "919999999999@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig, () => now);
    store.applyDeletes({ jid: pn, all: true });
    store.applyDeletes({ keys: [{ remoteJid: pn, id: "tombstone-before-map" }] });
    const revoke = directMessage({
      id: "outer-alt-revoke-envelope",
      jid: pn,
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.REVOKE,
          key: { remoteJid: pn, id: "outer-alt-before-map" },
        },
      },
    });
    revoke.key.remoteJidAlt = lid;
    store.ingestUpsert({ messages: [revoke], type: "notify" });

    now = clearAt + 2_000;
    const unknownAge = directMessage({
      id: "unknown-age-before-map",
      jid: lid,
      text: "unknown source time",
    });
    delete unknownAge.messageTimestamp;
    const outerAltTarget = directMessage({
      id: "outer-alt-before-map",
      jid: lid,
      text: "must stay revoked",
      timestamp: (now + 1_000) / 1_000,
    });
    store.ingestUpsert({ messages: [unknownAge, outerAltTarget], type: "notify" });
    store.applyUpdates([{
      key: { remoteJid: lid, id: "unknown-age-before-map" },
      update: { message: { editedMessage: { message: { conversation: "edited unknown source time" } } } },
    }]);
    const unknownBeforeMap = fixture.state.db.prepare(`
      SELECT text, source_timestamp_valid FROM messages
      WHERE source_id = 'unknown-age-before-map'
    `).get();
    assert.equal(unknownBeforeMap.text, "edited unknown source time");
    assert.equal(unknownBeforeMap.source_timestamp_valid, 0);
    const revokedBeforeMap = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages WHERE source_id = 'outer-alt-before-map'
    `).get();
    assert.equal(revokedBeforeMap.text, null);
    assert.ok(revokedBeforeMap.deleted_at);
    assert.deepEqual(
      fixture.state.db.prepare(`
        SELECT transport_chat_jid FROM message_tombstones
        WHERE source_id = 'outer-alt-before-map' ORDER BY transport_chat_jid
      `).all().map((row) => row.transport_chat_jid),
      [lid, pn].sort(),
    );
    store.linkLidMapping(lid, pn);
    const replayedUnknown = directMessage({
      id: "unknown-age-before-map",
      jid: lid,
      text: "future-dated replay must stay hidden",
      timestamp: (now + 1_000) / 1_000,
    });
    replayedUnknown.key.remoteJidAlt = pn;
    store.ingestUpsert({ messages: [replayedUnknown], type: "notify" });
    const cleared = directMessage({
      id: "cleared-before-map",
      jid: lid,
      text: "must stay cleared",
      timestamp: (clearAt - 1_000) / 1_000,
    });
    cleared.key.remoteJidAlt = pn;
    const tombstoned = directMessage({
      id: "tombstone-before-map",
      jid: lid,
      text: "must stay tombstoned",
      timestamp: (now + 1_000) / 1_000,
    });
    tombstoned.key.remoteJidAlt = pn;
    store.ingestUpsert({ messages: [cleared, tombstoned], type: "notify" });

    const editable = directMessage({
      id: "edit-across-alias",
      jid: lid,
      text: "before",
      timestamp: (now + 1_000) / 1_000,
    });
    editable.key.remoteJidAlt = pn;
    store.ingestUpsert({ messages: [editable], type: "notify" });
    store.applyUpdates([{
      key: { remoteJid: pn, id: "edit-across-alias" },
      update: { message: { editedMessage: { message: { conversation: "after" } } } },
    }]);

    const rows = fixture.state.db.prepare(`
      SELECT source_id, text, deleted_at, edited_at FROM messages ORDER BY source_id
    `).all();
    const bySource = new Map(rows.map((row) => [row.source_id, row]));
    for (const sourceId of [
      "cleared-before-map",
      "outer-alt-before-map",
      "tombstone-before-map",
      "unknown-age-before-map",
    ]) {
      assert.equal(bySource.get(sourceId).text, null, sourceId);
      assert.ok(bySource.get(sourceId).deleted_at, sourceId);
    }
    assert.equal(bySource.get("edit-across-alias").text, "after");
    assert.ok(bySource.get("edit-across-alias").edited_at);
  } finally {
    await fixture.cleanup();
  }
});

test("an edit that first reveals PN/LID aliases cannot bypass an earlier tombstone", async () => {
  const fixture = await temporaryState();
  try {
    const pn = "919999999999@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.applyDeletes({ keys: [{ remoteJid: pn, id: "edit-first-alias" }] });
    store.ingestUpsert({
      messages: [directMessage({
        id: "edit-first-alias",
        jid: lid,
        text: "visible before alias evidence",
      })],
      type: "notify",
    });
    assert.equal(
      fixture.state.db.prepare(
        "SELECT text FROM messages WHERE source_id = 'edit-first-alias'",
      ).get().text,
      "visible before alias evidence",
    );

    store.applyUpdates([{
      key: {
        remoteJid: pn,
        remoteJidAlt: lid,
        id: "edit-first-alias",
      },
      update: { message: { editedMessage: { message: { conversation: "must stay deleted" } } } },
    }]);

    const row = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages WHERE source_id = 'edit-first-alias'
    `).get();
    assert.equal(row.text, null);
    assert.ok(row.deleted_at);
    assert.deepEqual(
      fixture.state.db.prepare(`
        SELECT transport_chat_jid FROM message_tombstones
        WHERE source_id = 'edit-first-alias' ORDER BY transport_chat_jid
      `).all().map((item) => item.transport_chat_jid),
      [lid, pn].sort(),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("device-suffixed edit keys preserve their LID alias while targeting canonical PN rows", async () => {
  const fixture = await temporaryState();
  try {
    const pn = "919999999999@s.whatsapp.net";
    const devicePn = "919999999999:4@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.applyDeletes({ keys: [{ remoteJid: lid, id: "device-edit-first-alias" }] });
    store.ingestUpsert({
      messages: [directMessage({
        id: "device-edit-first-alias",
        jid: pn,
        text: "visible before alias evidence",
      })],
      type: "notify",
    });

    store.applyUpdates([{
      key: {
        remoteJid: devicePn,
        remoteJidAlt: lid,
        id: "device-edit-first-alias",
      },
      update: { message: { editedMessage: { message: { conversation: "must stay deleted" } } } },
    }]);

    const row = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages WHERE source_id = 'device-edit-first-alias'
    `).get();
    assert.equal(row.text, null);
    assert.ok(row.deleted_at);
    assert.deepEqual(
      fixture.state.db.prepare(`
        SELECT transport_chat_jid FROM message_tombstones
        WHERE source_id = 'device-edit-first-alias' ORDER BY transport_chat_jid
      `).all().map((item) => item.transport_chat_jid),
      [lid, pn].sort(),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a same-kind inner revoke alternate cannot mask a valid outer PN/LID alias", async () => {
  const fixture = await temporaryState();
  try {
    const pn = "919999999999@s.whatsapp.net";
    const secondPn = "918888888888@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const revokedKey = { remoteJid: pn, id: "outer-alias-wins" };
    revokedKey.remoteJidAlt = secondPn;
    const revoke = directMessage({
      id: "same-kind-inner-revoke",
      jid: pn,
      message: {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.REVOKE,
          key: revokedKey,
        },
      },
    });
    revoke.key.remoteJidAlt = lid;
    store.ingestUpsert({ messages: [revoke], type: "notify" });
    store.ingestUpsert({
      messages: [directMessage({
        id: "outer-alias-wins",
        jid: lid,
        text: "must stay revoked",
      })],
      type: "notify",
    });

    const row = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages WHERE source_id = 'outer-alias-wins'
    `).get();
    assert.equal(row.text, null);
    assert.ok(row.deleted_at);
    assert.deepEqual(
      fixture.state.db.prepare(`
        SELECT transport_chat_jid FROM message_tombstones
        WHERE source_id = 'outer-alias-wins' ORDER BY transport_chat_jid
      `).all().map((item) => item.transport_chat_jid),
      [lid, pn].sort(),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("update-event revokes combine their embedded key with the outer PN/LID alias", async () => {
  const fixture = await temporaryState();
  try {
    const pn = "919999999999@s.whatsapp.net";
    const lid = "777777777777777@lid";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    store.applyUpdates([{
      key: {
        remoteJid: pn,
        remoteJidAlt: lid,
        id: "update-revoke-envelope",
      },
      update: {
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: pn, id: "update-revoked-before-arrival" },
          },
        },
      },
    }]);
    store.ingestUpsert({
      messages: [directMessage({
        id: "update-revoked-before-arrival",
        jid: lid,
        text: "must stay revoked",
      })],
      type: "notify",
    });

    const row = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages
      WHERE source_id = 'update-revoked-before-arrival'
    `).get();
    assert.equal(row.text, null);
    assert.ok(row.deleted_at);
    assert.deepEqual(
      fixture.state.db.prepare(`
        SELECT transport_chat_jid FROM message_tombstones
        WHERE source_id = 'update-revoked-before-arrival' ORDER BY transport_chat_jid
      `).all().map((item) => item.transport_chat_jid),
      [lid, pn].sort(),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("view-once is monotonic across duplicate arrival order", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const viewOnce = (id) => directMessage({
      id,
      message: {
        viewOnceMessageV2: {
          message: { imageMessage: { mimetype: "image/jpeg", caption: "private" } },
        },
      },
    });
    store.ingestUpsert({ messages: [viewOnce("private-first")], type: "append" });
    store.ingestUpsert({ messages: [directMessage({ id: "private-first", text: "replayed clear" })], type: "append" });
    store.ingestUpsert({ messages: [directMessage({ id: "private-last", text: "initial clear" })], type: "append" });
    store.ingestUpsert({ messages: [viewOnce("private-last")], type: "append" });
    const rows = fixture.state.db.prepare(`
      SELECT source_id, view_once, text, media_kind, raw_json
      FROM messages WHERE source_id LIKE 'private-%' ORDER BY source_id
    `).all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.view_once, 1);
      assert.equal(row.text, null);
      assert.equal(row.media_kind, null);
      assert.equal(row.raw_json, null);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("far-future timestamps are bounded locally and cannot bypass retention", async () => {
  const fixture = await temporaryState();
  try {
    let now = 1_700_000_000_000;
    const store = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      { retentionMs: 1_000, maxMessagesPerChat: 200 },
      () => now,
    );
    store.ingestUpsert({
      messages: [directMessage({ id: "future", text: "bounded", timestamp: 8_000_000_000_000 })],
      type: "append",
    });
    const row = fixture.state.db.prepare(
      "SELECT timestamp, created_at FROM messages WHERE source_id = 'future'",
    ).get();
    assert.equal(row.timestamp, now);
    assert.equal(row.created_at, now);
    const chat = store.listChats().items[0];
    assert.equal(store.readChat({ chatId: chat.chatId }).items[0].timestamp, new Date(now).toISOString());
    now += 1_001;
    store.prune();
    assert.equal(fixture.state.counts().messages, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("chat-clear markers prevent older history from repopulating after clear-before-history", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const jid = "919999999999@s.whatsapp.net";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig, () => now);
    store.applyDeletes({ jid, all: true });
    store.ingestUpsert({
      messages: [directMessage({ id: "old-notify", jid, text: "must stay cleared", timestamp: (now - 4_000) / 1_000 })],
      type: "notify",
    });
    store.ingestHistory({
      chats: [], contacts: [],
      messages: [directMessage({ id: "older-history", jid, text: "must stay cleared", timestamp: (now - 5_000) / 1_000 })],
    });
    const missingTimestamp = directMessage({ id: "missing-time", jid, text: "must fail closed" });
    delete missingTimestamp.messageTimestamp;
    store.ingestHistory({ chats: [], contacts: [], messages: [missingTimestamp] });
    store.ingestUpsert({
      messages: [directMessage({ id: "new-live", jid, text: "allowed live", timestamp: (now + 1_000) / 1_000 })],
      type: "notify",
    });
    const chat = store.listChats().items[0];
    const messages = store.readChat({ chatId: chat.chatId }).items;
    assert.equal(messages.find((message) => message.sourceId === "old-notify").text, undefined);
    assert.ok(messages.find((message) => message.sourceId === "old-notify").deletedAt);
    assert.equal(messages.find((message) => message.sourceId === "older-history").text, undefined);
    assert.ok(messages.find((message) => message.sourceId === "older-history").deletedAt);
    assert.equal(messages.find((message) => message.sourceId === "missing-time").text, undefined);
    assert.ok(messages.find((message) => message.sourceId === "missing-time").deletedAt);
    assert.equal(messages.find((message) => message.sourceId === "new-live").text, "allowed live");
  } finally {
    await fixture.cleanup();
  }
});

test("deleted chats tombstone existing messages and refuse queued or replayed old content", async () => {
  const fixture = await temporaryState();
  try {
    const now = Date.now();
    const jid = "919999999999@s.whatsapp.net";
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig, () => now);
    store.ingestUpsert({
      messages: [directMessage({ id: "before-chat-delete", jid, text: "remove me", timestamp: (now - 5_000) / 1_000 })],
      type: "append",
    });
    store.deleteChats([jid]);
    assert.equal(store.listChats().items.length, 0);
    assert.equal(store.searchMessages({ query: "remove me" }).items.length, 0);

    store.ingestUpsert({
      messages: [directMessage({ id: "before-chat-delete", jid, text: "queued duplicate", timestamp: (now - 5_000) / 1_000 })],
      type: "notify",
    });
    const missingTimestamp = directMessage({ id: "missing-after-delete", jid, text: "unknown age" });
    delete missingTimestamp.messageTimestamp;
    store.ingestUpsert({ messages: [missingTimestamp], type: "notify" });
    store.ingestHistory({
      chats: [],
      contacts: [],
      messages: [directMessage({ id: "old-history-after-delete", jid, text: "old history", timestamp: (now - 4_000) / 1_000 })],
    });
    store.ingestUpsert({
      messages: [directMessage({ id: "new-after-delete", jid, text: "new live", timestamp: (now + 1_000) / 1_000 })],
      type: "notify",
    });

    const chat = store.listChats().items[0];
    const bySource = new Map(store.readChat({ chatId: chat.chatId }).items.map((item) => [item.sourceId, item]));
    assert.equal(bySource.get("before-chat-delete").text, undefined);
    assert.equal(bySource.get("missing-after-delete").text, undefined);
    assert.equal(bySource.get("old-history-after-delete").text, undefined);
    assert.equal(bySource.get("new-after-delete").text, "new live");
    assert.ok(bySource.get("before-chat-delete").deletedAt);
    assert.ok(bySource.get("missing-after-delete").deletedAt);
    assert.ok(bySource.get("old-history-after-delete").deletedAt);
  } finally {
    await fixture.cleanup();
  }
});

test("group updates retain only the bounded chat title, never participant metadata", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const jid = "100000000000@g.us";
    store.upsertGroups([{
      id: jid,
      subject: "Private group",
      participants: [{ id: "919999999999@s.whatsapp.net" }],
    }]);
    assert.equal(fixture.state.db.prepare("SELECT COUNT(*) AS count FROM groups").get().count, 0);
    assert.equal(store.listChats().items[0].title, "Private group");
    store.deleteChats([jid]);
    assert.equal(fixture.state.db.prepare("SELECT COUNT(*) AS count FROM groups").get().count, 0);
    assert.equal(store.listChats().items.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("edited payloads survive original-history duplicates and edit-before-original order", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const original = directMessage({ id: "edit-then-original", text: "old" });
    store.ingestUpsert({ messages: [original], type: "append" });
    store.applyUpdates([{
      key: original.key,
      update: { message: { editedMessage: { message: { conversation: "edited wins" } } } },
    }]);
    store.ingestHistory({ chats: [], contacts: [], messages: [original] });

    const beforeOriginalKey = directMessage({ id: "edit-before-original", text: "late old" }).key;
    store.applyUpdates([{
      key: beforeOriginalKey,
      update: { message: { editedMessage: { message: { conversation: "early edit wins" } } } },
    }]);
    store.ingestHistory({
      chats: [], contacts: [],
      messages: [directMessage({ id: "edit-before-original", text: "late old" })],
    });
    const chat = store.listChats().items[0];
    const bySource = new Map(store.readChat({ chatId: chat.chatId }).items.map((message) => [message.sourceId, message]));
    assert.equal(bySource.get("edit-then-original").text, "edited wins");
    assert.ok(bySource.get("edit-then-original").editedAt);
    assert.equal(bySource.get("edit-before-original").text, "early edit wins");
    assert.ok(bySource.get("edit-before-original").editedAt);
  } finally {
    await fixture.cleanup();
  }
});

test("disappearing expiry uses message start time rather than old setting-change time", async () => {
  const currentSeconds = Math.floor(Date.now() / 1_000);
  const message = directMessage({
    id: "ephemeral-current",
    timestamp: currentSeconds,
    message: {
      extendedTextMessage: {
        text: "still current",
        contextInfo: {
          expiration: 60,
          ephemeralSettingTimestamp: currentSeconds - 86_400,
        },
      },
    },
  });
  message.ephemeralStartTimestamp = currentSeconds;
  message.ephemeralDuration = 60;
  const parsed = parseMessage(message);
  assert.equal(parsed.expiresAt, currentSeconds * 1_000 + 60_000);
});

test("parser bounds identifiers, text, and public media metadata", () => {
  const oversizedId = directMessage({ id: "x".repeat(513), text: "ignored" });
  assert.equal(parseMessage(oversizedId), undefined);

  const message = directMessage({
    id: "bounded-fields",
    message: {
      documentMessage: {
        mimetype: `application/${"x".repeat(400)}`,
        fileName: `${"f".repeat(700)}.txt`,
        caption: "c".repeat(70_000),
        contextInfo: { stanzaId: "q".repeat(513) },
      },
    },
  });
  message.key.participant = "not-a-user-jid";
  message.key.remoteJidAlt = `${"9".repeat(200)}@s.whatsapp.net`;
  message.key.participantAlt = `${"8".repeat(200)}@lid`;
  const parsed = parseMessage(message);
  assert.equal(parsed.text.length, 65_536);
  assert.equal(parsed.media.mime.length, 256);
  assert.equal(parsed.media.filename.length, 512);
  assert.equal(parsed.quotedSourceId, undefined);
  assert.equal(parsed.participantJid, undefined);
  assert.equal(parsed.alternateRemoteJid, undefined);
  assert.equal(parsed.alternateParticipantJid, undefined);
  assert.equal(parsed.rawJson.includes("not-a-user-jid"), false);

  const backslashLocator = directMessage({
    id: "backslash-locator",
    message: {
      imageMessage: {
        directPath: "/\\unexpected-host/path",
        mediaKey: Buffer.alloc(32, 1),
        mimetype: "image/png",
      },
    },
  });
  const boundedLocator = parseMessage(backslashLocator);
  assert.equal(boundedLocator.rawJson.includes("directPath"), false);
  assert.equal(boundedLocator.rawJson.includes("unexpected-host"), false);

  const malformedRevoke = directMessage({
    id: "revoke-envelope",
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.REVOKE,
        key: {
          remoteJid: "919999999999@s.whatsapp.net",
          id: "r".repeat(513),
        },
      },
    },
  });
  assert.equal(parseMessage(malformedRevoke), undefined);
});

test("delete and edit events reject unbounded transport identifiers", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const jid = "919999999999@s.whatsapp.net";
    const oversizedId = "d".repeat(513);
    store.applyDeletes({ keys: [{ remoteJid: jid, id: oversizedId }] });
    store.applyDeletes({ keys: [{ remoteJid: `${"9".repeat(200)}@s.whatsapp.net`, id: "bounded" }] });
    store.applyUpdates([{
      key: { remoteJid: jid, id: "update-envelope" },
      update: {
        message: {
          protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.REVOKE,
            key: { remoteJid: jid, id: oversizedId },
          },
        },
      },
    }]);
    assert.equal(
      fixture.state.db.prepare("SELECT COUNT(*) AS count FROM message_tombstones").get().count,
      0,
    );

    const valid = directMessage({ id: "valid-after-malformed-edit", jid, text: "delete me" });
    store.ingestUpsert({ messages: [valid], type: "notify" });
    assert.doesNotThrow(() => store.applyUpdates([
      {
        key: { remoteJid: `${"9".repeat(200)}@s.whatsapp.net`, id: "malformed-edit" },
        update: { message: { editedMessage: { message: { conversation: "ignored" } } } },
      },
      {
        key: valid.key,
        update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
      },
    ]));
    const redacted = fixture.state.db.prepare(`
      SELECT text, deleted_at FROM messages WHERE source_id = 'valid-after-malformed-edit'
    `).get();
    assert.equal(redacted.text, null);
    assert.ok(redacted.deleted_at);
  } finally {
    await fixture.cleanup();
  }
});

test("retained raw messages use a minimal allowlist while preserving media and quote keys", async () => {
  const fixture = await temporaryState();
  try {
    const store = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const rich = directMessage({
      id: "minimal-raw",
      message: {
        imageMessage: {
          url: "https://127.0.0.1/private",
          directPath: "/encrypted/path",
          mediaKey: Buffer.alloc(32, 7),
          fileSha256: Buffer.from([4]),
          fileEncSha256: Buffer.from([5]),
          fileLength: 123,
          mimetype: "image/jpeg",
          caption: "allowed caption",
          messageSecret: Buffer.from("forbidden-secret"),
          jpegThumbnail: Buffer.from("forbidden-thumbnail"),
          contextInfo: {
            stanzaId: "quoted-id",
            participant: "919999999999@s.whatsapp.net",
            remoteJid: "919999999999@s.whatsapp.net",
            mentionedJid: ["918888888888@s.whatsapp.net"],
            quotedMessage: { conversation: "forbidden-quoted-body" },
          },
        },
        messageContextInfo: { messageSecret: Buffer.from("forbidden-context") },
      },
    });
    rich.pushName = "forbidden-push-name";
    rich.userReceipt = [{ userJid: "917777777777@s.whatsapp.net" }];
    rich.reactions = [{ text: "forbidden-reaction" }];
    store.ingestUpsert({ messages: [rich], type: "append" });
    const chat = store.listChats().items[0];
    const stored = store.readChat({ chatId: chat.chatId }).items[0];
    const raw = store.getRetainedMessage(stored.messageId).raw;
    assert.equal(raw.pushName, undefined);
    assert.equal(raw.userReceipt, undefined);
    assert.equal(raw.reactions, undefined);
    assert.equal(raw.message.messageContextInfo, undefined);
    assert.equal(raw.message.imageMessage.url, undefined);
    assert.equal(raw.message.imageMessage.directPath, "/encrypted/path");
    assert.deepEqual(Buffer.from(raw.message.imageMessage.mediaKey), Buffer.alloc(32, 7));
    assert.equal(raw.message.imageMessage.messageSecret, undefined);
    assert.equal(raw.message.imageMessage.jpegThumbnail, undefined);
    assert.equal(raw.key.id, "minimal-raw");
    assert.equal(raw.messageTimestamp, undefined);
    assert.equal(raw.message.imageMessage.contextInfo, undefined);
    assert.equal(raw.message.imageMessage.fileSha256, undefined);
    assert.equal(raw.message.imageMessage.fileEncSha256, undefined);
    const serialized = JSON.stringify(raw);
    for (const forbidden of [
      "forbidden-secret",
      "forbidden-thumbnail",
      "forbidden-quoted-body",
      "forbidden-push-name",
      "forbidden-reaction",
    ]) assert.equal(serialized.includes(forbidden), false);
  } finally {
    await fixture.cleanup();
  }
});
