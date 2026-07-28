import test from "node:test";
import assert from "node:assert/strict";
import { EventRouter } from "../dist/whatsapp/eventRouter.js";

class Events {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  off(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener)); }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

test("event router carries history mappings without treating transport or first history as complete", async () => {
  const calls = [];
  let complete = 0;
  const messages = {
    linkLidMapping: (lid, pn) => calls.push(["live-map", lid, pn]),
    linkUserAliases() {},
    ingestHistory: (history) => calls.push(["history", history.lidPnMappings?.[0]?.lid]),
    ingestUpsert() {}, applyUpdates() {}, applyDeletes() {}, upsertChats() {}, deleteChats() {},
    upsertContacts() {}, upsertGroups() {}, updateGroupParticipants() {},
  };
  const auth = { saveCreds: async () => undefined };
  const events = new Events();
  const detach = new EventRouter(auth, messages).attach(events, {
    onHistoryComplete: () => { complete += 1; },
  });
  events.emit("connection.update", { receivedPendingNotifications: true });
  events.emit("messaging-history.set", {
    chats: [], contacts: [], messages: [],
    lidPnMappings: [{ lid: "7@lid", pn: "9@s.whatsapp.net" }],
    isLatest: true,
  });
  events.emit("messaging-history.status", { status: "complete" });
  events.emit("lid-mapping.update", { lid: "8@lid", pn: "10@s.whatsapp.net" });
  assert.deepEqual(calls, [["history", "7@lid"], ["live-map", "8@lid", "10@s.whatsapp.net"]]);
  assert.equal(complete, 0);
  detach();
  assert.equal([...events.listeners.values()].every((listeners) => listeners.length === 0), true);
});

test("event router completes only after ingesting the final recent-history chunk", () => {
  const calls = [];
  const messages = {
    linkLidMapping() {}, linkUserAliases() {},
    ingestHistory: (history) => calls.push(["history", history.syncType, history.progress]),
    ingestUpsert() {}, applyUpdates() {}, applyDeletes() {}, upsertChats() {}, deleteChats() {},
    upsertContacts() {}, upsertGroups() {}, updateGroupParticipants() {},
  };
  const events = new Events();
  new EventRouter({ saveCreds: async () => undefined }, messages).attach(events, {
    onHistoryComplete: () => calls.push(["complete"]),
  });

  events.emit("messaging-history.set", {
    chats: [], contacts: [], messages: [], syncType: 0, progress: 100,
  });
  events.emit("messaging-history.set", {
    chats: [], contacts: [], messages: [], syncType: 3, progress: 80,
  });
  events.emit("messaging-history.set", {
    chats: [], contacts: [], messages: [], syncType: 3, progress: 100,
  });

  assert.deepEqual(calls, [
    ["history", 0, 100],
    ["history", 3, 80],
    ["history", 3, 100],
    ["complete"],
  ]);
});

test("credential persistence failures are caught and surfaced through the hook", async () => {
  const events = new Events();
  let failure;
  const auth = { saveCreds: async () => { throw new Error("disk secret detail"); } };
  const messages = {
    linkLidMapping() {}, linkUserAliases() {}, ingestHistory() {}, ingestUpsert() {}, applyUpdates() {},
    applyDeletes() {}, upsertChats() {}, deleteChats() {}, upsertContacts() {}, upsertGroups() {},
    updateGroupParticipants() {},
  };
  const router = new EventRouter(auth, messages);
  router.attach(events, { onPersistenceError: (error) => { failure = error; } });
  events.emit("creds.update", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure.message, "disk secret detail");
  await assert.rejects(router.waitForCredentialPersistence(), /disk secret detail/u);
});

test("credential persistence is serialized and exposes an awaitable restart barrier", async () => {
  const events = new Events();
  const calls = [];
  const releases = [];
  const auth = {
    saveCreds: (update) => new Promise((resolve) => {
      calls.push(update.sequence);
      releases.push(resolve);
    }),
  };
  const messages = {
    linkLidMapping() {}, linkUserAliases() {}, ingestHistory() {}, ingestUpsert() {}, applyUpdates() {},
    applyDeletes() {}, upsertChats() {}, deleteChats() {}, upsertContacts() {}, upsertGroups() {},
    updateGroupParticipants() {},
  };
  const router = new EventRouter(auth, messages);
  router.attach(events);
  events.emit("creds.update", { sequence: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1]);
  let persisted = false;
  const barrier = router.waitForCredentialPersistence().then(() => { persisted = true; });
  events.emit("creds.update", { sequence: 2 });
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1, 2]);
  assert.equal(persisted, false);
  releases.shift()();
  await barrier;
  assert.equal(persisted, true);
});

test("synchronous message-store failures never escape the Baileys emitter", () => {
  const events = new Events();
  let failure;
  const messages = {
    linkLidMapping() {}, linkUserAliases() {}, ingestHistory() {},
    ingestUpsert() { throw new Error("sqlite failed"); }, applyUpdates() {}, applyDeletes() {},
    upsertChats() {}, deleteChats() {}, upsertContacts() {}, upsertGroups() {},
    updateGroupParticipants() {},
  };
  new EventRouter({ saveCreds: async () => undefined }, messages).attach(events, {
    onPersistenceError: (error) => { failure = error; },
  });
  assert.doesNotThrow(() => events.emit("messages.upsert", { messages: [], type: "notify" }));
  assert.equal(failure.message, "sqlite failed");
});
