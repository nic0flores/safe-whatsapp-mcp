// Agent context note: Creates production Baileys sockets with passive presence, compatible bounded history sync, one-batch on-demand history access, live group-send metadata, and no database-backed retry relay. Tests: test/core-session-client.test.mjs and test/on-demand-history.test.mjs. Never use full-history registration for the bounded local cache, stale cached participants, or resend messages that bypassed this MCP's confirmation flow; update this note after meaningful changes.
import makeWASocket, { Browsers, type WAMessage } from "baileys";
import type { SqliteAuthState } from "../auth/sqliteAuthState.js";
import type { SocketEvents, SocketFactory, WhatsAppSocket } from "./socketTypes.js";

export class BaileysSocketFactory implements SocketFactory {
  constructor(
    private readonly auth: SqliteAuthState,
  ) {}

  async create(): Promise<WhatsAppSocket> {
    const socket = makeWASocket({
      auth: this.auth.state,
      logger: silentLogger as never,
      browser: Browsers.appropriate("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) =>
        jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.includes("@newsletter"),
      getMessage: noPersistentRetryMessage,
    });
    return {
      events: {
        on: (event, listener) => socket.ev.on(event as never, listener),
        off: (event, listener) => socket.ev.off(event as never, listener),
      } satisfies SocketEvents,
      user: socket.user ? { id: socket.user.id, ...(socket.user.name ? { name: socket.user.name } : {}) } : undefined,
      end: (error) => socket.end(error),
      logout: () => socket.logout(),
      onWhatsApp: async (...phoneNumbers) => (await socket.onWhatsApp(...phoneNumbers)) ?? [],
      fetchMessageHistory: (count, oldestMessageKey, oldestMessageTimestampMs) =>
        socket.fetchMessageHistory(count, oldestMessageKey, oldestMessageTimestampMs),
      sendMessage: async (jid, content, options) =>
        socket.sendMessage(jid, content as never, options as never) as Promise<WAMessage | undefined>,
    };
  }
}

export async function noPersistentRetryMessage(): Promise<undefined> {
  return undefined;
}

const silentLogger = {
  level: "silent",
  child() { return this; },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
