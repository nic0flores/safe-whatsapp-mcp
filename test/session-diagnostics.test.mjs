import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../dist/whatsapp/sessionManager.js";

class Events {
  listeners = new Map();
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  off(name, listener) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener)); }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

class Socket {
  events = new Events();
  end() {}
  async logout() {}
  async onWhatsApp() { return []; }
  async fetchMessageHistory() { return "request"; }
  async resyncAppState() {}
  async waitForMessage() { return undefined; }
  async sendMessage() { return undefined; }
}

const router = {
  attach(events, hooks) {
    const listener = (update) => hooks.onConnectionUpdate?.(update);
    events.on("connection.update", listener);
    return () => events.off("connection.update", listener);
  },
  async waitForCredentialPersistence() {},
};

test("pairing failure exposes only sanitized transport status classification", async () => {
  const factory = {
    async create() {
      const socket = new Socket();
      setImmediate(() => socket.events.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 411 }, secret: "do-not-leak" } },
      }));
      return socket;
    },
  };
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 50,
    connectionBudgetMs: 50,
    syncTimeoutMs: 50,
    idleTimeoutMs: 1_000,
    maxRetries: 0,
  });
  await assert.rejects(sessions.connect(), (error) => {
    assert.equal(error.code, "connection_multidevice_mismatch");
    assert.match(error.message, /transport status 411: multidevice_mismatch/u);
    assert.equal(error.message.includes("do-not-leak"), false);
    return true;
  });
  assert.equal(sessions.snapshot().failureCode, "connection_multidevice_mismatch");
});

test("pairing timeout is distinguished from an unknown connection failure", async () => {
  const factory = { async create() { return new Socket(); } };
  const sessions = new SessionManager(factory, router, {
    connectionTimeoutMs: 5,
    connectionBudgetMs: 5,
    syncTimeoutMs: 5,
    idleTimeoutMs: 1_000,
    maxRetries: 0,
  });
  await assert.rejects(sessions.connect(), (error) => {
    assert.equal(error.code, "connection_timeout");
    assert.match(error.message, /handshake timeout/u);
    return true;
  });
});
