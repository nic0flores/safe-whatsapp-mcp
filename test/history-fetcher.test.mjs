import test from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { WhatsAppHistoryFetcher } from "../dist/whatsapp/historyFetcher.js";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { EventRouter } from "../dist/whatsapp/eventRouter.js";
import { directMessage, runtimeConfig, temporaryState } from "./core-helpers.mjs";

class Events {
  listeners = new Map();
  on(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  off(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  emit(name, value) {
    for (const listener of this.listeners.get(name) ?? []) listener(value);
  }
}

function sessionsFor(socket, completeness = "complete") {
  return {
    async run(operation) {
      return { value: await operation(socket), syncCompleteness: completeness };
    },
  };
}

test("history fetcher requests one exact batch and reports only retained metadata", async () => {
  const fixture = await temporaryState();
  const now = Date.now();
  const jid = "919999999999@s.whatsapp.net";
  const config = { ...runtimeConfig, retentionMs: 60_000, maxMessagesPerChat: 10 };
  try {
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), config);
    messages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "anchor-source", jid, timestamp: (now - 1_000) / 1_000 })],
    });
    const chatId = fixture.state.db.prepare(
      "SELECT id FROM chats WHERE transport_jid = ?",
    ).get(jid).id;
    const events = new Events();
    const detachRouter = new EventRouter(
      { async saveCreds() {} },
      messages,
    ).attach(events);
    const older = directMessage({ id: "older-source", jid, timestamp: (now - 2_000) / 1_000 });
    const socket = {
      events,
      async fetchMessageHistory(count, key, timestampMs) {
        assert.equal(count, 25);
        assert.deepEqual(key, { remoteJid: jid, id: "anchor-source", fromMe: false });
        assert.ok(timestampMs >= now - 1_100 && timestampMs <= now - 900);
        setImmediate(() => {
          events.emit("messaging-history.set", {
            chats: [],
            contacts: [],
            syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
            peerDataRequestSessionId: "history-request-secret",
            messages: [older],
          });
        });
        return "history-request-secret";
      },
    };
    const fetcher = new WhatsAppHistoryFetcher(
      fixture.state,
      messages,
      sessionsFor(socket),
      config,
      { timeoutMs: 100 },
    );

    const result = await fetcher.fetch({ chatId, limit: 25 });

    assert.equal(result.outcome, "received");
    assert.equal(result.requestedCount, 25);
    assert.equal(result.receivedCount, 1);
    assert.equal(result.retainedCount, 1);
    assert.equal(result.newlyRetainedCount, 1);
    assert.equal(result.anchorAdvanced, true);
    assert.equal(result.syncCompleteness, "complete");
    assert.equal(result.retention.cachedMessageCount, 2);
    assert.notEqual(result.nextBeforeMessageId, undefined);
    assert.equal(JSON.stringify(result).includes(jid), false);
    assert.equal(JSON.stringify(result).includes("history-request-secret"), false);
    detachRouter();
  } finally {
    await fixture.cleanup();
  }
});

test("history fetcher reports retention limits without sending a pointless request", async () => {
  const fixture = await temporaryState();
  const now = Date.now();
  const jid = "919999999999@s.whatsapp.net";
  const config = { ...runtimeConfig, retentionMs: 60_000, maxMessagesPerChat: 1 };
  let calls = 0;
  try {
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), config);
    messages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "only-anchor", jid, timestamp: (now - 1_000) / 1_000 })],
    });
    const chatId = fixture.state.db.prepare(
      "SELECT id FROM chats WHERE transport_jid = ?",
    ).get(jid).id;
    const socket = {
      events: new Events(),
      async fetchMessageHistory() { calls += 1; return "should-not-send"; },
    };
    const fetcher = new WhatsAppHistoryFetcher(
      fixture.state,
      messages,
      sessionsFor(socket, "partial"),
      config,
      { timeoutMs: 100 },
    );

    const result = await fetcher.fetch({ chatId, limit: 50 });

    assert.equal(result.outcome, "retention_limited");
    assert.deepEqual(result.blockedBy, ["message_cap"]);
    assert.equal(result.syncCompleteness, "partial");
    assert.equal(calls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("history fetcher returns pending, rejects overlap, and never exposes a request ID", async () => {
  const fixture = await temporaryState();
  const now = Date.now();
  const jid = "919999999999@s.whatsapp.net";
  const config = { ...runtimeConfig, retentionMs: 60_000, maxMessagesPerChat: 10 };
  try {
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), config);
    messages.ingestUpsert({
      type: "append",
      messages: [directMessage({ id: "pending-anchor", jid, timestamp: (now - 1_000) / 1_000 })],
    });
    const chatId = fixture.state.db.prepare(
      "SELECT id FROM chats WHERE transport_jid = ?",
    ).get(jid).id;
    const socket = {
      events: new Events(),
      async fetchMessageHistory() {
        setTimeout(() => socket.events.emit("messaging-history.set", {
          chats: [],
          contacts: [],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          peerDataRequestSessionId: "private-pending-request",
          messages: [directMessage({
            id: "late-older",
            jid,
            timestamp: (now - 2_000) / 1_000,
          })],
        }), 25);
        return "private-pending-request";
      },
    };
    const detachRouter = new EventRouter(
      { async saveCreds() {} },
      messages,
    ).attach(socket.events);
    const fetcher = new WhatsAppHistoryFetcher(
      fixture.state,
      messages,
      sessionsFor(socket),
      config,
      { timeoutMs: 10 },
    );

    const first = fetcher.fetch({ chatId, limit: 10 });
    await assert.rejects(
      fetcher.fetch({ chatId, limit: 10 }),
      (error) => error.code === "history_fetch_in_progress",
    );
    const result = await first;
    assert.equal(result.outcome, "pending");
    assert.equal(result.lateResponseMayStillSync, true);
    assert.equal(JSON.stringify(result).includes("private-pending-request"), false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      fixture.state.db.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(chatId).count,
      2,
    );
    detachRouter();
    await assert.rejects(
      fetcher.fetch({ chatId, limit: 51 }),
      (error) => error.code === "invalid_history_request",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("history fetcher reports duplicate responses without claiming progress", async () => {
  const fixture = await temporaryState();
  const now = Date.now();
  const jid = "919999999999@s.whatsapp.net";
  const config = { ...runtimeConfig, retentionMs: 60_000, maxMessagesPerChat: 10 };
  try {
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), config);
    const anchor = directMessage({ id: "duplicate-anchor", jid, timestamp: (now - 1_000) / 1_000 });
    messages.ingestUpsert({ type: "append", messages: [anchor] });
    const chatId = fixture.state.db.prepare(
      "SELECT id FROM chats WHERE transport_jid = ?",
    ).get(jid).id;
    const events = new Events();
    const detachRouter = new EventRouter(
      { async saveCreds() {} },
      messages,
    ).attach(events);
    const socket = {
      events,
      async fetchMessageHistory() {
        setImmediate(() => events.emit("messaging-history.set", {
          chats: [],
          contacts: [],
          syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
          peerDataRequestSessionId: "duplicate-request",
          messages: [anchor],
        }));
        return "duplicate-request";
      },
    };
    const fetcher = new WhatsAppHistoryFetcher(
      fixture.state,
      messages,
      sessionsFor(socket),
      config,
      { timeoutMs: 100 },
    );

    const result = await fetcher.fetch({ chatId, limit: 10 });

    assert.equal(result.outcome, "received");
    assert.equal(result.retainedCount, 1);
    assert.equal(result.newlyRetainedCount, 0);
    assert.equal(result.anchorAdvanced, false);
    detachRouter();
  } finally {
    await fixture.cleanup();
  }
});
