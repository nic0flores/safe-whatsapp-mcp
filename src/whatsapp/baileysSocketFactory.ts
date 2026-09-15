// Agent context note: Creates production Baileys sockets with passive presence, no local send echoes/retries, exact-ID acknowledgement waits, app-state resync, and full direct-chat history bootstrap only when registering a new encrypted V3 companion. Tests: test/outbound-acknowledgement.test.mjs, test/core-session-client.test.mjs, test/on-demand-history.test.mjs, and test/wa-version-pinning.test.mjs. Never resend messages that bypassed confirmation; history remains filtered before persistence by HardenedMessageStore.
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  Browsers,
  fetchLatestWaWebVersion,
  type WAMessage,
  type WAVersion,
} from "baileys";
import type { SqliteAuthState } from "../auth/sqliteAuthState.js";
import type { SocketEvents, SocketFactory, WhatsAppSocket } from "./socketTypes.js";

// Baileys' full-history guidance uses a desktop companion profile rather than
// the host OS browser identity. Keep the companion identity stable across the
// registration socket and the post-pair restart so WhatsApp sees one device
// profile throughout the bootstrap, even when this process runs on Windows.
export const V3_COMPANION_BROWSER = Browsers.macOS("Desktop");

type WaWebVersionFetcher = () => Promise<{ version: WAVersion }>;

/**
 * Resolve the current WhatsApp Web version once per factory lifetime and pin it
 * across all retries plus the mandatory post-pair restart. A registration
 * attempt must not switch protocol revisions halfway through the same linked
 * device bootstrap.
 */
export function createPinnedWaWebVersionResolver(
  fetcher: WaWebVersionFetcher = fetchLatestWaWebVersion,
): () => Promise<WAVersion> {
  let pinned: Promise<WAVersion> | undefined;
  return () => {
    pinned ??= fetcher().then(({ version }) => version);
    return pinned;
  };
}

export class BaileysSocketFactory implements SocketFactory {
  private readonly resolveVersion: () => Promise<WAVersion>;

  constructor(
    private readonly auth: SqliteAuthState,
    versionFetcher: WaWebVersionFetcher = fetchLatestWaWebVersion,
  ) {
    this.resolveVersion = createPinnedWaWebVersionResolver(versionFetcher);
  }

  async create(): Promise<WhatsAppSocket> {
    // Baileys encodes requireFullSync in the companion registration payload.
    // Requesting it again while reopening an already-paired device can change
    // the login profile of that device without renegotiating registration.
    // Existing companions therefore reconnect normally; a fresh pairing asks
    // the phone for the full-history bootstrap once at registration time.
    const requestFullHistory = !this.auth.isPaired();
    const version = await this.resolveVersion();
    const socket = makeWASocket({
      auth: this.auth.state,
      version,
      logger: silentLogger as never,
      browser: V3_COMPANION_BROWSER,
      markOnlineOnConnect: false,
      syncFullHistory: requestFullHistory,
      // Keep accepting FULL notifications after the registration socket
      // restarts, because the replacement socket is already considered paired.
      shouldSyncHistoryMessage: () => true,
      ...SAFE_OUTBOUND_SOCKET_POLICY,
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
      resyncAppState: () => socket.resyncAppState(ALL_WA_PATCH_NAMES, false),
      waitForMessage: (messageId, timeoutMs) => socket.waitForMessage(messageId, timeoutMs),
      sendMessage: async (jid, content, options) =>
        socket.sendMessage(jid, content as never, options as never) as Promise<WAMessage | undefined>,
    };
  }
}

export const SAFE_OUTBOUND_SOCKET_POLICY = Object.freeze({
  emitOwnEvents: false,
  enableRecentMessageCache: false,
});

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
