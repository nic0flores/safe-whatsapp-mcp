import test from "node:test";
import assert from "node:assert/strict";
import { approvalPreviewFor, digestSend } from "../dist/replies/digest.js";
import { OutboundFailureJournal } from "../dist/replies/outboundFailureJournal.js";
import { FilePendingSendStore } from "../dist/replies/pendingStore.js";
import { temporaryState } from "./core-helpers.mjs";

test("late rejection changes only an exact uncertain or sent transport record", async () => {
  const fixture = await temporaryState();
  try {
    const store = new FilePendingSendStore(fixture.paths.pendingDir);
    const uncertain = terminalRecord("33333333-3333-4333-8333-333333333333", "transport-1");
    const sent = { ...terminalRecord("44444444-4444-4444-8444-444444444444", "transport-2"), state: "sent" };
    await store.create(uncertain);
    await store.create(sent);
    assert.equal(await store.reconcileTransportFailure("wrong-id", "whatsapp_rejected", new Date()), undefined);
    await store.reconcileTransportFailure("transport-1", "whatsapp_rejected_463", new Date());
    await store.reconcileTransportFailure("transport-2", "whatsapp_rejected_479", new Date());
    assert.deepEqual(
      [(await store.get(uncertain.id)).state, (await store.get(sent.id)).state],
      ["failed", "failed"],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a transport ID is durable while the send is still in progress", async () => {
  const fixture = await temporaryState();
  try {
    const store = new FilePendingSendStore(fixture.paths.pendingDir);
    const id = "55555555-5555-4555-8555-555555555555";
    const payload = {
      kind: "text",
      destination: {
        chatId: "chat-1",
        transportJid: "12025550123@s.whatsapp.net",
        kind: "direct",
        e164: "+12025550123",
      },
      text: "hello",
    };
    const approvalPreview = approvalPreviewFor(payload, id);
    const prepared = {
      ...terminalRecord(id, undefined),
      state: "prepared",
      payload,
      digest: digestSend(payload, approvalPreview, id),
      approvalPreview,
      errorCode: undefined,
    };
    await store.create(prepared);
    const now = new Date("2026-08-05T13:00:00.000Z");
    await store.claim(prepared.id, prepared.digest, approvalPreview, now);
    await store.bindTransportMessageId(prepared.id, "transport-bound", now);
    const stored = await store.get(prepared.id);
    assert.equal(stored.state, "sending");
    assert.equal(stored.transportMessageId, "transport-bound");
  } finally {
    await fixture.cleanup();
  }
});

test("late rejection metadata survives until exact-ID reconciliation removes it", async () => {
  const fixture = await temporaryState();
  try {
    const journal = new OutboundFailureJournal(fixture.state);
    journal.record("transport-late", "whatsapp_rejected_463", new Date("2026-08-05T13:00:00Z"));
    assert.deepEqual(journal.list(), [{
      messageId: "transport-late",
      errorCode: "whatsapp_rejected_463",
      receivedAt: "2026-08-05T13:00:00.000Z",
    }]);
    journal.remove("transport-late");
    assert.deepEqual(journal.list(), []);
  } finally {
    await fixture.cleanup();
  }
});

function terminalRecord(id, transportMessageId) {
  return {
    id,
    state: "uncertain",
    messageKind: "text",
    destinationKind: "direct",
    payload: null,
    digest: "a".repeat(64),
    approvalPreview: null,
    createdAt: "2026-08-05T12:59:59.000Z",
    updatedAt: "2026-08-05T13:00:01.000Z",
    expiresAt: "2026-08-05T13:10:00.000Z",
    transportMessageId,
    errorCode: "transport_outcome_unknown",
  };
}
