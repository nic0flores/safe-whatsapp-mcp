import test from "node:test";
import assert from "node:assert/strict";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { HistoryAnchorStore } from "../dist/messages/historyAnchorStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { directMessage, temporaryState } from "./core-helpers.mjs";

const jid = "919999999999@s.whatsapp.net";
const secondJid = "918888888888@s.whatsapp.net";

test("history anchors use the oldest eligible chat-local message and millisecond timestamp", async () => {
  const fixture = await temporaryState();
  const now = 1_700_000_000_000;
  const config = { retentionMs: 10_000, maxMessagesPerChat: 10 };
  try {
    const messages = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      config,
      () => now,
    );
    const deleted = directMessage({ id: "deleted", jid, timestamp: (now - 5_000) / 1_000 });
    const viewOnce = directMessage({
      id: "view-once",
      jid,
      timestamp: (now - 6_000) / 1_000,
      message: { viewOnceMessageV2: { message: { imageMessage: { caption: "private" } } } },
    });
    const missingTimestamp = directMessage({ id: "missing-time", jid });
    delete missingTimestamp.messageTimestamp;
    messages.ingestUpsert({
      type: "append",
      messages: [
        directMessage({ id: "valid-oldest", jid, timestamp: (now - 4_000) / 1_000 }),
        directMessage({
          id: "valid-newer",
          jid,
          timestamp: (now - 1_000) / 1_000,
          fromMe: true,
        }),
        deleted,
        viewOnce,
        directMessage({ id: "expired", jid, timestamp: (now - 7_000) / 1_000 }),
        missingTimestamp,
      ],
    });
    messages.applyDeletes({ keys: [deleted.key] });
    fixture.state.db.prepare(
      "UPDATE messages SET expires_at = ? WHERE source_id = 'expired'",
    ).run(now - 1);

    const chatId = idForChat(fixture.state, jid);
    const store = new HistoryAnchorStore(fixture.state, config, () => now);
    const automatic = store.resolve({ chatId });
    const explicitId = idForMessage(fixture.state, "valid-newer");
    const explicit = store.resolve({ chatId, beforeMessageId: automatic.messageId });

    assert.equal(automatic.messageId, idForMessage(fixture.state, "valid-oldest"));
    assert.deepEqual(automatic.key, {
      remoteJid: jid,
      id: "valid-oldest",
      fromMe: false,
    });
    assert.equal(automatic.timestampMs, now - 4_000);
    assert.equal(explicit.messageId, automatic.messageId);
    assert.equal(explicit.key.id, "valid-oldest");
    assert.equal(explicit.key.fromMe, false);
    assert.throws(
      () => store.resolve({ chatId, beforeMessageId: explicitId }),
      (error) => error.code === "history_anchor_not_oldest",
    );
    assert.deepEqual(automatic.retention, {
      retentionDays: 10_000 / 86_400_000,
      maxMessagesPerChat: 10,
      cachedMessageCount: 5,
      capacityRemaining: 5,
      cutoffAt: new Date(now - 10_000).toISOString(),
      canRetainOlder: true,
    });

    const response = store.summarizeResponse(
      chatId,
      [
        "valid-oldest",
        "valid-newer",
        "valid-oldest",
        "deleted",
        "view-once",
        "expired",
        "missing-time",
        "not-returned",
      ],
      new Set(["valid-newer"]),
    );
    assert.equal(response.retainedCount, 2);
    assert.equal(response.newlyRetainedCount, 1);
    assert.equal(response.nextBeforeMessageId, automatic.messageId);
    assert.equal(response.oldestRetainedAt, new Date(now - 4_000).toISOString());
  } finally {
    await fixture.cleanup();
  }
});

test("explicit history anchors fail closed across chats and for ineligible messages", async () => {
  const fixture = await temporaryState();
  const now = 1_700_000_000_000;
  const config = { retentionMs: 10_000, maxMessagesPerChat: 20 };
  try {
    const messages = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      config,
      () => now,
    );
    const invalidTime = directMessage({ id: "invalid-time", jid });
    delete invalidTime.messageTimestamp;
    const deleted = directMessage({ id: "deleted-anchor", jid, timestamp: (now - 2_000) / 1_000 });
    messages.ingestUpsert({
      type: "append",
      messages: [
        invalidTime,
        deleted,
        directMessage({ id: "other-chat", jid: secondJid, timestamp: (now - 1_000) / 1_000 }),
      ],
    });
    messages.applyDeletes({ keys: [deleted.key] });

    const chatId = idForChat(fixture.state, jid);
    const store = new HistoryAnchorStore(fixture.state, config, () => now);
    for (const beforeMessageId of [
      idForMessage(fixture.state, "invalid-time"),
      idForMessage(fixture.state, "deleted-anchor"),
      idForMessage(fixture.state, "other-chat"),
      "00000000-0000-4000-8000-000000000000",
    ]) {
      assert.throws(
        () => store.resolve({ chatId, beforeMessageId }),
        (error) => error.code === "history_anchor_unavailable",
      );
    }
    assert.throws(
      () => store.resolve({ chatId: "00000000-0000-4000-8000-000000000000" }),
      (error) => error.code === "chat_not_found",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("history retention state reports time and per-chat capacity boundaries", async () => {
  const fixture = await temporaryState();
  const now = 1_700_000_000_000;
  try {
    const timeConfig = { retentionMs: 1_000, maxMessagesPerChat: 10 };
    const timeMessages = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      timeConfig,
      () => now,
    );
    timeMessages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "at-cutoff", jid, timestamp: (now - 1_000) / 1_000 })],
    });
    const chatId = idForChat(fixture.state, jid);
    const atCutoff = new HistoryAnchorStore(fixture.state, timeConfig, () => now).resolve({ chatId });
    assert.equal(atCutoff.retention.canRetainOlder, false);
    assert.equal(atCutoff.retention.capacityRemaining, 9);
    assert.equal(atCutoff.retention.cutoffAt, new Date(now - 1_000).toISOString());

    const capacityConfig = { retentionMs: 10_000, maxMessagesPerChat: 2 };
    timeMessages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "newer", jid, timestamp: (now - 500) / 1_000 })],
    });
    const capacity = new HistoryAnchorStore(fixture.state, capacityConfig, () => now);
    const full = capacity.resolve({ chatId });
    assert.equal(full.retention.cachedMessageCount, 2);
    assert.equal(full.retention.capacityRemaining, 0);
    assert.equal(full.retention.canRetainOlder, false);

    const summary = capacity.summarizeResponse(
      chatId,
      ["at-cutoff", "newer", "newer"],
      new Set(["at-cutoff"]),
    );
    assert.equal(summary.retainedCount, 2);
    assert.equal(summary.newlyRetainedCount, 1);
    assert.equal(summary.nextBeforeMessageId, idForMessage(fixture.state, "at-cutoff"));
    assert.throws(
      () => capacity.summarizeResponse(
        chatId,
        Array.from({ length: 51 }, (_, index) => `m-${index}`),
        new Set(),
      ),
      (error) => error.code === "history_response_invalid",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("corrupt transport metadata is never used as a history anchor", async () => {
  const fixture = await temporaryState();
  const now = 1_700_000_000_000;
  const config = { retentionMs: 10_000, maxMessagesPerChat: 10 };
  try {
    const messages = new MessageStore(
      fixture.state,
      new IdentityStore(fixture.state),
      config,
      () => now,
    );
    messages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "corrupt", jid, timestamp: (now - 1_000) / 1_000 })],
    });
    const chatId = idForChat(fixture.state, jid);
    fixture.state.db.prepare(
      "UPDATE messages SET transport_chat_jid = 'status@broadcast' WHERE source_id = 'corrupt'",
    ).run();
    const store = new HistoryAnchorStore(fixture.state, config, () => now);
    assert.throws(
      () => store.resolve({ chatId }),
      (error) => error.code === "history_anchor_invalid",
    );
  } finally {
    await fixture.cleanup();
  }
});

function idForChat(state, transportJid) {
  return state.db.prepare("SELECT id FROM chats WHERE transport_jid = ?").get(transportJid).id;
}

function idForMessage(state, sourceId) {
  return state.db.prepare("SELECT id FROM messages WHERE source_id = ?").get(sourceId).id;
}
