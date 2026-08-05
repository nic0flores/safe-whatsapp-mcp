import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../dist/whatsapp/sessionManager.js";
import { WhatsAppClient } from "../dist/whatsapp/client.js";
import { noPersistentRetryMessage } from "../dist/whatsapp/baileysSocketFactory.js";
import { encodeBaileys } from "../dist/auth/serialization.js";
import { SqliteAuthState } from "../dist/auth/sqliteAuthState.js";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { directMessage, runtimeConfig, temporaryState } from "./core-helpers.mjs";

class Events {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  off(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener)); }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

class FakeSocket {
  events = new Events();
  ended = 0; loggedOut = 0; resyncs = 0; sent = [];
  end() { this.ended += 1; }
  async logout() { this.loggedOut += 1; }
  async onWhatsApp(number) { return [{ exists: true, jid: `${number}@s.whatsapp.net` }]; }
  async resyncAppState() { this.resyncs += 1; }
  async waitForMessage(id) { return { tag: "ack", attrs: { id, class: "message" } }; }
  async sendMessage(jid, content, options) {
    this.sent.push({ jid, content, options });
    return { key: { id: options.messageId, remoteJid: jid, fromMe: true }, messageTimestamp: 1_700_000_000 };
  }
  getMessage() { return undefined; }
}

class Router {
  attach(events, hooks) {
    const connection = (update) => hooks.onConnectionUpdate?.(update);
    const history = () => hooks.onHistoryComplete?.();
    events.on("connection.update", connection);
    events.on("history.complete", history);
    return () => {
      events.off("connection.update", connection);
      events.off("history.complete", history);
    };
  }
  async waitForCredentialPersistence() {}
}

function factoryThat(opener) {
  const factory = {
    calls: 0,
    sockets: [],
    async create() {
      factory.calls += 1;
      const socket = new FakeSocket();
      factory.sockets.push(socket);
      opener(socket, factory.calls);
      return socket;
    },
  };
  return factory;
}

test("persistent retry lookup never relays database messages", async () => {
  assert.equal(await noPersistentRetryMessage({
    remoteJid: "919999999999@s.whatsapp.net",
    id: "authored-on-another-device",
    fromMe: true,
  }), undefined);
});

test("lazy connection is single-flight, reaches complete sync, and ordinary idle close never logs out", async () => {
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", { connection: "open" });
    socket.events.emit("history.complete");
  }));
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 50, syncTimeoutMs: 50, idleTimeoutMs: 15,
  });
  assert.deepEqual(await Promise.all([sessions.connect(), sessions.connect()]), ["complete", "complete"]);
  assert.equal(factory.calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(factory.sockets[0].ended, 1);
  assert.equal(factory.sockets[0].loggedOut, 0);
});

test("pending notifications start history rather than completing it, and unlink is explicit", async () => {
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    });
  }));
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 50, syncTimeoutMs: 5, idleTimeoutMs: 1_000,
  });
  assert.equal(await sessions.connect(), "partial");
  await sessions.unlink();
  assert.equal(factory.sockets[0].loggedOut, 1);
  assert.equal(factory.sockets[0].ended, 0);
});

test("disconnect during opening closes the eventual socket and cancels the caller", async () => {
  const factory = factoryThat((socket) => setTimeout(() => {
    socket.events.emit("connection.update", { connection: "open" });
  }, 15));
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 50, syncTimeoutMs: 1, idleTimeoutMs: 1_000,
  });
  const connecting = sessions.connect();
  await new Promise((resolve) => setTimeout(resolve, 2));
  await sessions.disconnect();
  await assert.rejects(connecting, (error) => error.code === "connection_cancelled");
  assert.equal(factory.sockets[0].ended, 1);
  assert.equal(factory.sockets[0].loggedOut, 0);
});

test("disconnect promptly cancels an unscanned QR wait", async () => {
  const factory = factoryThat(() => undefined);
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 5_000, syncTimeoutMs: 1, idleTimeoutMs: 1_000,
  });
  const connecting = sessions.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await sessions.disconnect();
  assert.ok(Date.now() - started < 250);
  await assert.rejects(connecting, (error) => error.code === "connection_cancelled");
  assert.equal(factory.sockets[0].ended, 1);
});

test("transient failures retry but authentication failures do not", async () => {
  const socket = new FakeSocket();
  const transient = {
    calls: 0,
    async create() {
      this.calls += 1;
      if (this.calls < 3) throw new Error("transient");
      setImmediate(() => {
        socket.events.emit("connection.update", { connection: "open" });
        socket.events.emit("history.complete");
      });
      return socket;
    },
  };
  const sessions = new SessionManager(transient, new Router(), {
    connectionTimeoutMs: 50, syncTimeoutMs: 20, idleTimeoutMs: 1_000, maxRetries: 3,
  });
  assert.equal(await sessions.connect(), "complete");
  assert.equal(transient.calls, 3);
  await sessions.disconnect();

  const fatal = { calls: 0, async create() { this.calls += 1; throw { output: { statusCode: 401 } }; } };
  const fatalSessions = new SessionManager(fatal, new Router(), {
    connectionTimeoutMs: 5, syncTimeoutMs: 5, idleTimeoutMs: 1_000,
  });
  await assert.rejects(fatalSessions.connect(), /bounded retries/);
  assert.equal(fatal.calls, 1);
});

test("QR pairing waits for credential persistence before the required restart", async () => {
  let releasePersistence;
  let sawRestart;
  const restartSeen = new Promise((resolve) => { sawRestart = resolve; });
  const router = {
    persistence: Promise.resolve(),
    attach(events, hooks) {
      const connection = (update) => hooks.onConnectionUpdate(update);
      const history = () => hooks.onHistoryComplete();
      const credentials = () => {
        this.persistence = new Promise((resolve) => { releasePersistence = resolve; });
      };
      events.on("connection.update", connection);
      events.on("creds.update", credentials);
      events.on("history.complete", history);
      return () => {
        events.off("connection.update", connection);
        events.off("creds.update", credentials);
        events.off("history.complete", history);
      };
    },
    waitForCredentialPersistence() { return this.persistence; },
  };
  const lifecycle = [];
  const factory = factoryThat((socket, call) => setImmediate(() => {
    if (call === 1) {
      socket.events.emit("connection.update", { qr: "synthetic-qr" });
      socket.events.emit("creds.update", { me: { id: "1@s.whatsapp.net" }, account: {} });
      socket.events.emit("connection.update", { isNewLogin: true, qr: undefined });
      socket.events.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });
      sawRestart();
      return;
    }
    socket.events.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    });
    socket.events.emit("history.complete");
  }));
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 1_000,
    connectionBudgetMs: 2_000,
    syncTimeoutMs: 100,
    idleTimeoutMs: 1_000,
    onQr: () => lifecycle.push("qr"),
    onPairingAccepted: () => lifecycle.push("accepted"),
  });

  const connecting = sessions.connect();
  await restartSeen;
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(factory.calls, 1, "replacement socket must wait for durable credentials");
  releasePersistence();
  assert.equal(await connecting, "complete");
  assert.equal(factory.calls, 2);
  assert.deepEqual(lifecycle, ["qr", "accepted"]);
  await sessions.disconnect();
});

test("a post-open close aborts initial sync immediately", async () => {
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", { connection: "open" });
    setImmediate(() => socket.events.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Error("transport detail") },
    }));
  }));
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 100,
    syncTimeoutMs: 2_000,
    idleTimeoutMs: 1_000,
  });
  const started = Date.now();
  await assert.rejects(sessions.connect(), (error) => error.code === "connection_closed");
  assert.ok(Date.now() - started < 250);
});

test("disconnect waits for asynchronous socket shutdown", async () => {
  let finishEnding;
  const factory = factoryThat((socket) => {
    socket.end = () => new Promise((resolve) => { finishEnding = resolve; });
    setImmediate(() => socket.events.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    }));
    setImmediate(() => socket.events.emit("history.complete"));
  });
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 100,
    syncTimeoutMs: 100,
    idleTimeoutMs: 1_000,
  });
  await sessions.connect();
  let closed = false;
  const disconnecting = sessions.disconnect().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finishEnding();
  await disconnecting;
  assert.equal(closed, true);
});

test("disconnect waits for queued credential persistence", async () => {
  let finishPersistence;
  let persistence = Promise.resolve();
  const router = new Router();
  router.waitForCredentialPersistence = () => persistence;
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    });
    socket.events.emit("history.complete");
  }));
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 100,
    syncTimeoutMs: 100,
    idleTimeoutMs: 1_000,
  });
  await sessions.connect();
  persistence = new Promise((resolve) => { finishPersistence = resolve; });
  let closed = false;
  const disconnecting = sessions.disconnect().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finishPersistence();
  await disconnecting;
  assert.equal(closed, true);
});

test("connect cannot report success before final credentials are durable", async () => {
  let rejectPersistence;
  const persistence = new Promise((_resolve, reject) => { rejectPersistence = reject; });
  const router = new Router();
  router.waitForCredentialPersistence = () => persistence;
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", {
      connection: "open",
      receivedPendingNotifications: true,
    });
    socket.events.emit("history.complete");
  }));
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 100,
    syncTimeoutMs: 100,
    idleTimeoutMs: 1_000,
  });
  let succeeded = false;
  const connecting = sessions.connect().then(() => { succeeded = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(succeeded, false);
  rejectPersistence(new Error("disk detail"));
  await assert.rejects(connecting, (error) => error.code === "auth_persistence_failed");
  assert.equal(succeeded, false);
  await sessions.disconnect().catch(() => undefined);
});

test("credential persistence failure closes the socket and surfaces safe connection health", async () => {
  const factory = factoryThat(() => undefined);
  const router = {
    attach(_events, hooks) {
      setImmediate(() => hooks.onPersistenceError(new Error("sensitive disk detail")));
      return () => undefined;
    },
  };
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 50, syncTimeoutMs: 5, idleTimeoutMs: 1_000,
  });
  await assert.rejects(sessions.connect(), (error) => error.code === "auth_persistence_failed");
  assert.equal(factory.calls, 1);
  assert.equal(factory.sockets[0].ended, 1);
  assert.equal(sessions.snapshot().failureCode, "auth_persistence_failed");
});

test("credential persistence failure during sync aborts the in-flight connect", async () => {
  const factory = factoryThat(() => undefined);
  const router = {
    attach(events, hooks) {
      const listener = (update) => hooks.onConnectionUpdate(update);
      events.on("connection.update", listener);
      setImmediate(() => {
        events.emit("connection.update", { connection: "open" });
        setTimeout(() => hooks.onPersistenceError(new Error("disk failure")), 2);
      });
      return () => events.off("connection.update", listener);
    },
  };
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 50, syncTimeoutMs: 30, idleTimeoutMs: 1_000,
  });
  await assert.rejects(sessions.connect(), (error) => error.code === "auth_persistence_failed");
  assert.equal(factory.sockets[0].ended, 1);
});

test("credential persistence failure races and aborts an in-flight socket operation", async () => {
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", { connection: "open" });
    socket.events.emit("history.complete");
  }));
  let hooks;
  const router = {
    attach(events, attachedHooks) {
      hooks = attachedHooks;
      const connection = (update) => attachedHooks.onConnectionUpdate(update);
      const history = () => attachedHooks.onHistoryComplete();
      events.on("connection.update", connection);
      events.on("history.complete", history);
      return () => {
        events.off("connection.update", connection);
        events.off("history.complete", history);
      };
    },
    async waitForCredentialPersistence() {},
  };
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 50, syncTimeoutMs: 20, idleTimeoutMs: 1_000,
  });
  await sessions.connect();
  const running = sessions.run(async () => new Promise(() => undefined));
  setImmediate(() => hooks.onPersistenceError(new Error("disk failed")));
  await assert.rejects(running, (error) => error.code === "auth_persistence_failed");
  assert.equal(factory.sockets[0].ended, 1);
});

test("connection close aborts an in-flight operation with a safe error", async () => {
  const factory = factoryThat((socket) => setImmediate(() => {
    socket.events.emit("connection.update", { connection: "open" });
    socket.events.emit("history.complete");
  }));
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 50, syncTimeoutMs: 20, idleTimeoutMs: 1_000,
  });
  await sessions.connect();
  const running = sessions.run(async () => new Promise(() => undefined));
  setImmediate(() => factory.sockets[0].events.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: new Error("internal transport detail") },
  }));
  await assert.rejects(running, (error) => error.code === "connection_closed");
});

test("connection retries share one total budget", async () => {
  const factory = factoryThat(() => undefined);
  const sessions = new SessionManager(factory, new Router(), {
    connectionTimeoutMs: 30,
    connectionBudgetMs: 12,
    syncTimeoutMs: 30,
    idleTimeoutMs: 1_000,
    maxRetries: 3,
  });
  const started = Date.now();
  await assert.rejects(sessions.connect(), /bounded retries/);
  assert.ok(Date.now() - started < 100);
  assert.equal(factory.calls, 1);
});

test("MCP-facing client reads fail immediately before pairing and direct sends require verified E.164", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    let connects = 0;
    const socket = new FakeSocket();
    const sessions = {
      snapshot: () => ({ connected: false, connecting: false }),
      connect: async () => { connects += 1; return "complete"; },
      run: async (operation) => ({ value: await operation(socket), syncCompleteness: "complete" }),
      disconnect: async () => undefined,
      unlink: async () => undefined,
    };
    const client = new WhatsAppClient(
      fixture.state, messages, sessions, runtimeConfig, undefined, () => auth.isPaired(),
    );
    await assert.rejects(client.listChats(), (error) => error.code === "pairing_required");
    assert.equal(connects, 0);

    await auth.saveCreds({ registered: true });
    assert.equal(await client.resyncMessages(), "complete");
    assert.equal(socket.resyncs, 1);
    messages.ingestUpsert({ messages: [directMessage({ id: "one" })], type: "append" });
    const direct = messages.listChats().items[0];
    await assert.rejects(
      client.resolveDestination({ chatId: direct.chatId }),
      (error) => error.code === "direct_destination_requires_e164",
    );
    const destination = await client.resolveDestination({ e164: "+919999999999" });
    assert.equal(destination.transportJid, "919999999999@s.whatsapp.net");
    const sent = await client.sendMessage(destination, { text: "hello" });
    assert.deepEqual([sent.outcome, sent.sourceId], ["accepted", socket.sent[0].options.messageId]);
    assert.equal(socket.sent[0].jid, "919999999999@s.whatsapp.net");

    socket.onWhatsApp = async () => [{ exists: true, jid: "918888888888@s.whatsapp.net" }];
    await assert.rejects(
      client.resolveDestination({ e164: "+919999999999" }),
      (error) => error.code === "destination_verification_failed",
    );
    socket.onWhatsApp = async () => [
      { exists: true, jid: "919999999999@s.whatsapp.net" },
      { exists: true, jid: "918888888888@s.whatsapp.net" },
    ];
    await assert.rejects(
      client.resolveDestination({ e164: "+919999999999" }),
      (error) => error.code === "destination_verification_failed",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("accepted, rejected, and uncertain sends enter history only through WhatsApp events", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const socket = new FakeSocket();
    const sessions = {
      snapshot: () => ({ connected: true, connecting: false, syncCompleteness: "complete" }),
      run: async (operation) => ({ value: await operation(socket), syncCompleteness: "complete" }),
      disconnect: async () => undefined,
      unlink: async () => undefined,
    };
    const client = new WhatsAppClient(
      fixture.state,
      messages,
      sessions,
      { ...runtimeConfig, syncTimeoutMs: 5 },
      undefined,
      () => auth.isPaired(),
    );
    const destination = {
      chatId: "direct-chat",
      transportJid: "919999999999@s.whatsapp.net",
      kind: "direct",
      e164: "+919999999999",
    };

    const accepted = await client.sendMessage(destination, { text: "accepted" });
    socket.waitForMessage = async (id) => ({
      tag: "ack",
      attrs: { id, class: "message", error: "463" },
    });
    assert.equal((await client.sendMessage(destination, { text: "rejected" })).outcome, "rejected");
    socket.waitForMessage = async () => undefined;
    assert.equal((await client.sendMessage(destination, { text: "uncertain" })).outcome, "uncertain");
    assert.equal(fixture.state.counts().messages, 0);

    messages.ingestUpsert({
      type: "notify",
      messages: [directMessage({ id: accepted.sourceId, fromMe: true, text: "accepted" })],
    });
    assert.equal(fixture.state.counts().messages, 1);
    assert.equal(messages.listChats().items[0].latestSnippet, "accepted");
  } finally {
    await fixture.cleanup();
  }
});

test("verified E.164 reply reuses the inbound LID chat and quoted transport", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    const inbound = directMessage({ id: "lid-inbound", jid: "777777777777777@lid", text: "Can you help?" });
    inbound.key.remoteJidAlt = "919999999999@s.whatsapp.net";
    messages.ingestUpsert({ messages: [inbound], type: "notify" });
    const chat = messages.listChats().items[0];
    const retained = messages.readChat({ chatId: chat.chatId }).items[0];
    const socket = new FakeSocket();
    const sessions = {
      snapshot: () => ({ connected: true, connecting: false, syncCompleteness: "complete" }),
      connect: async () => "complete",
      run: async (operation) => ({ value: await operation(socket), syncCompleteness: "complete" }),
      disconnect: async () => undefined,
      unlink: async () => undefined,
    };
    const client = new WhatsAppClient(
      fixture.state, messages, sessions, runtimeConfig, undefined, () => auth.isPaired(),
    );
    const destination = await client.resolveDestination({ e164: "+919999999999" });
    assert.equal(destination.chatId, chat.chatId);
    assert.equal(destination.transportJid, "777777777777777@lid");
    await client.sendMessage(destination, { text: "Yes" }, retained.messageId);
    assert.equal(socket.sent[0].jid, "777777777777777@lid");
    assert.equal(socket.sent[0].options.quoted.key.id, "lid-inbound");
  } finally {
    await fixture.cleanup();
  }
});

test("late PN/LID convergence routes a quoted reply through its original LID chat", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    const identities = new IdentityStore(fixture.state);
    const messages = new MessageStore(fixture.state, identities, runtimeConfig);
    const lidInbound = directMessage({
      id: "before-mapping",
      jid: "777777777777777@lid",
      text: "Reply to this",
      timestamp: Math.floor(Date.now() / 1_000) - 10,
    });
    messages.ingestUpsert({ messages: [lidInbound], type: "notify" });
    const lidChat = messages.listChats().items[0];
    const replyTarget = messages.readChat({ chatId: lidChat.chatId }).items[0];
    messages.ingestUpsert({
      messages: [directMessage({ id: "pn-newer", text: "separate PN", timestamp: Math.floor(Date.now() / 1_000) })],
      type: "append",
    });
    identities.linkLid("777777777777777@lid", "919999999999@s.whatsapp.net");
    assert.equal(
      messages.readChat({ chatId: lidChat.chatId }).items[0].senderE164,
      "+919999999999",
    );

    const socket = new FakeSocket();
    const sessions = {
      snapshot: () => ({ connected: true, connecting: false }),
      connect: async () => "complete",
      run: async (operation) => ({ value: await operation(socket), syncCompleteness: "complete" }),
      disconnect: async () => undefined,
      unlink: async () => undefined,
    };
    const client = new WhatsAppClient(
      fixture.state, messages, sessions, runtimeConfig, undefined, () => auth.isPaired(),
    );
    const destination = await client.resolveDestination({ e164: "+919999999999" });
    assert.notEqual(destination.chatId, lidChat.chatId);
    assert.doesNotThrow(() => client.assertReplyTarget(destination.chatId, replyTarget.messageId));
    await client.sendMessage(destination, { text: "safe reply" }, replyTarget.messageId);
    assert.equal(socket.sent[0].jid, "777777777777777@lid");
  } finally {
    await fixture.cleanup();
  }
});

test("production media facade bounds streamed bytes and destroys the source on overflow", async () => {
  const fixture = await temporaryState();
  try {
    const auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    const messages = new MessageStore(fixture.state, new IdentityStore(fixture.state), runtimeConfig);
    messages.ingestUpsert({
      type: "append",
      messages: [directMessage({
        id: "photo",
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
            fileLength: 5,
            url: "https://127.0.0.1/legacy-host-must-not-pass",
            directPath: "/encrypted/photo",
            mediaKey: Buffer.alloc(32, 3),
          },
        },
      })],
    });
    const chat = messages.listChats().items[0];
    const mediaMessage = messages.readChat({ chatId: chat.chatId }).items[0];
    let destroyed = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.from([1, 2, 3]);
        yield Uint8Array.from([4, 5, 6]);
      },
      destroy() { destroyed += 1; },
    };
    const sessions = {
      snapshot: () => ({ connected: true, connecting: false }),
      connect: async () => "complete",
      run: async () => { throw new Error("not used"); },
      disconnect: async () => undefined,
      unlink: async () => undefined,
    };
    let downloaderNode;
    let downloaderCalls = 0;
    const client = new WhatsAppClient(
      fixture.state,
      messages,
      sessions,
      runtimeConfig,
      async (node) => {
        downloaderCalls += 1;
        downloaderNode = node;
        return source;
      },
      () => auth.isPaired(),
    );
    const stream = await client.downloadRetainedMedia(mediaMessage.messageId, 5);
    assert.deepEqual(Object.keys(downloaderNode).sort(), ["directPath", "mediaKey"]);
    assert.equal(downloaderNode.url, undefined);
    await assert.rejects(async () => {
      for await (const _chunk of stream) { /* consume */ }
    }, (error) => error.code === "media_too_large");
    assert.equal(destroyed, 1);
    assert.equal(downloaderCalls, 1);

    const legacy = directMessage({
      id: "legacy-backslash-locator",
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 1,
          directPath: "/\\unexpected-host/path",
          mediaKey: Buffer.alloc(32, 4),
        },
      },
    });
    messages.ingestUpsert({ messages: [legacy], type: "append" });
    const legacyStored = messages.readChat({ chatId: chat.chatId }).items.find(
      (item) => item.sourceId === "legacy-backslash-locator",
    );
    fixture.state.db.prepare("UPDATE messages SET raw_json = ? WHERE id = ?").run(
      encodeBaileys(legacy),
      legacyStored.messageId,
    );
    await assert.rejects(
      client.downloadRetainedMedia(legacyStored.messageId, 5),
      (error) => error.code === "media_unavailable",
    );
    assert.equal(downloaderCalls, 1);
  } finally {
    await fixture.cleanup();
  }
});
