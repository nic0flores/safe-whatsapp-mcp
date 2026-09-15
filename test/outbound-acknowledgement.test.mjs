import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAcknowledgement,
  rejectionErrorCode,
  sendAwaitingAcknowledgement,
} from "../dist/whatsapp/outboundAcknowledgement.js";
import {
  SAFE_OUTBOUND_SOCKET_POLICY,
  V3_COMPANION_BROWSER,
} from "../dist/whatsapp/baileysSocketFactory.js";

const input = {
  jid: "12025550123@s.whatsapp.net",
  content: { text: "hello" },
  messageId: "fixed-message-id",
  timeoutMs: 50,
};

test("delayed exact-ID server acknowledgement controls acceptance without retry", async () => {
  const ack = deferred();
  const socket = fakeSocket(() => ack.promise);
  let settled = false;
  const sending = sendAwaitingAcknowledgement(socket, input).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  ack.resolve(serverAck());
  assert.deepEqual(await sending, {
    outcome: "accepted",
    messageId: input.messageId,
    message: sentMessage(),
  });
  assert.equal(socket.sendCalls.length, 1);
  assert.deepEqual(socket.order, ["wait", "send"]);
});

test("acknowledgement listener wins a response race during the local write", async () => {
  const ack = deferred();
  const socket = fakeSocket(() => ack.promise, () => ack.resolve(serverAck()));
  const result = await sendAwaitingAcknowledgement(socket, input);
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(socket.order, ["wait", "send"]);
});

test("explicit server rejection is sanitized and never retried", async () => {
  const socket = fakeSocket(async () => serverAck("463"));
  const result = await sendAwaitingAcknowledgement(socket, input);
  assert.deepEqual(result, {
    outcome: "rejected",
    errorCode: "whatsapp_rejected_463",
    messageId: input.messageId,
    message: sentMessage(),
  });
  assert.equal(socket.sendCalls.length, 1);
  assert.equal(rejectionErrorCode("private server text"), "whatsapp_rejected");
});

test("timeout, disconnect, malformed response, and ID mismatch remain uncertain", async () => {
  for (const waiter of [
    () => new Promise(() => undefined),
    async () => { throw new Error("closed"); },
    async () => ({ tag: "receipt", attrs: { id: input.messageId } }),
  ]) {
    const socket = fakeSocket(waiter);
    assert.equal((await sendAwaitingAcknowledgement(socket, input)).outcome, "uncertain");
    assert.equal(socket.sendCalls.length, 1);
  }
  const mismatch = fakeSocket(async () => serverAck(), undefined, "different-id");
  assert.equal((await sendAwaitingAcknowledgement(mismatch, input)).outcome, "accepted");
  assert.deepEqual(classifyAcknowledgement(undefined, input.messageId), { outcome: "uncertain" });
  assert.deepEqual(
    classifyAcknowledgement(serverAck(undefined, "wrong-id"), input.messageId),
    { outcome: "uncertain" },
  );
});

test("the acknowledgement deadline also bounds a hung local relay", async () => {
  const socket = fakeSocket(() => new Promise(() => undefined));
  socket.sendMessage = () => new Promise(() => undefined);
  const started = Date.now();
  assert.equal((await sendAwaitingAcknowledgement(socket, input)).outcome, "uncertain");
  assert.ok(Date.now() - started < 250);
});

test("production socket policy disables local echoes and automatic message retries", () => {
  assert.deepEqual(SAFE_OUTBOUND_SOCKET_POLICY, {
    emitOwnEvents: false,
    enableRecentMessageCache: false,
  });
});

test("V3 uses the Baileys desktop companion profile required for richer history sync", () => {
  assert.deepEqual(V3_COMPANION_BROWSER, ["Mac OS", "Desktop", "14.4.1"]);
});

function fakeSocket(waiter, duringSend, returnedId = input.messageId) {
  return {
    order: [],
    sendCalls: [],
    waitForMessage(messageId, timeoutMs) {
      this.order.push("wait");
      assert.equal(messageId, input.messageId);
      assert.equal(timeoutMs, input.timeoutMs);
      return waiter();
    },
    async sendMessage(jid, content, options) {
      this.order.push("send");
      this.sendCalls.push({ jid, content, options });
      assert.equal(options.messageId, input.messageId);
      duringSend?.();
      return sentMessage(returnedId);
    },
  };
}

function serverAck(error, id = input.messageId) {
  return { tag: "ack", attrs: { id, class: "message", ...(error ? { error } : {}) } };
}

function sentMessage(id = input.messageId) {
  return { key: { id, remoteJid: input.jid, fromMe: true }, messageTimestamp: 1_700_000_000 };
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
