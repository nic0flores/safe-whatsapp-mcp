import test from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import {
  fetchOnDemandHistory,
  MAX_ON_DEMAND_HISTORY_MESSAGES,
} from "../dist/whatsapp/onDemandHistory.js";

class Events {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  off(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener)); }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

function fakeSocket(fetch) {
  return {
    events: new Events(),
    fetchMessageHistory: fetch,
  };
}

const anchor = {
  oldestMessageKey: {
    remoteJid: "919999999999@s.whatsapp.net",
    id: "oldest-source-id",
    fromMe: false,
  },
  oldestMessageTimestampMs: 1_700_000_000_000,
};

test("on-demand history listens before sending and accepts only the exact request response", async () => {
  let socket;
  socket = fakeSocket(async (count, key, timestampMs) => {
    assert.equal(count, MAX_ON_DEMAND_HISTORY_MESSAGES);
    assert.equal(key, anchor.oldestMessageKey);
    assert.equal(timestampMs, anchor.oldestMessageTimestampMs);
    socket.events.emit("messaging-history.set", {
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "other-request",
      messages: [{ key: { id: "wrong" } }],
    });
    setImmediate(() => socket.events.emit("messaging-history.set", {
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "request-1",
      messages: [{ key: { id: "older-1" } }],
    }));
    return "request-1";
  });

  const result = await fetchOnDemandHistory(socket, { ...anchor, timeoutMs: 100 });
  assert.equal(result.status, "received");
  assert.equal(result.requestId, "request-1");
  assert.equal(result.messages[0].key.id, "older-1");
  assert.equal(socket.events.listeners.get("messaging-history.set").length, 0);
});

test("on-demand history correlates a response that arrives before send returns", async () => {
  let socket;
  socket = fakeSocket(async () => {
    socket.events.emit("messaging-history.set", {
      syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
      peerDataRequestSessionId: "request-early",
      messages: [{ key: { id: "older-early" } }],
    });
    return "request-early";
  });

  const result = await fetchOnDemandHistory(socket, { ...anchor, timeoutMs: 100 });
  assert.equal(result.status, "received");
  assert.equal(result.messages[0].key.id, "older-early");
});

test("on-demand history returns pending on its bounded timeout and never retries", async () => {
  let calls = 0;
  const socket = fakeSocket(async () => {
    calls += 1;
    return "request-pending";
  });

  const result = await fetchOnDemandHistory(socket, { ...anchor, timeoutMs: 5 });
  assert.deepEqual(result, { status: "pending", requestId: "request-pending" });
  assert.equal(calls, 1);
  assert.equal(socket.events.listeners.get("messaging-history.set").length, 0);
});

test("on-demand history also bounds a send that never settles", async () => {
  let calls = 0;
  const socket = fakeSocket(async () => {
    calls += 1;
    return new Promise(() => undefined);
  });

  const result = await fetchOnDemandHistory(socket, { ...anchor, timeoutMs: 5 });
  assert.deepEqual(result, { status: "pending" });
  assert.equal(calls, 1);
  assert.equal(socket.events.listeners.get("messaging-history.set").length, 0);
});

test("on-demand history propagates a send failure without retrying and cleans its listener", async () => {
  let calls = 0;
  const socket = fakeSocket(async () => {
    calls += 1;
    throw new Error("send failed");
  });

  await assert.rejects(
    fetchOnDemandHistory(socket, { ...anchor, timeoutMs: 100 }),
    /send failed/,
  );
  assert.equal(calls, 1);
  assert.equal(socket.events.listeners.get("messaging-history.set").length, 0);
});

test("on-demand history rejects invalid count before touching the socket", async () => {
  let calls = 0;
  const socket = fakeSocket(async () => { calls += 1; return "never"; });
  await assert.rejects(
    fetchOnDemandHistory(socket, { ...anchor, count: 51 }),
    (error) => error.code === "invalid_history_request",
  );
  assert.equal(calls, 0);
});
