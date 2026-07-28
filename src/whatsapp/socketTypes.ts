// Agent context note: Defines the narrow fakeable socket boundary used by sessions, high-level clients, and one-batch on-demand history. Tests: test/core-session-client.test.mjs and test/on-demand-history.test.mjs. Keep normal shutdown separate from explicit logout and keep history timestamps in milliseconds; update this note after meaningful changes.
import type { WAMessage, WAMessageKey } from "baileys";

export interface ConnectionUpdate {
  connection?: "open" | "close" | "connecting";
  qr?: string;
  isNewLogin?: boolean;
  receivedPendingNotifications?: boolean;
  lastDisconnect?: { error?: unknown };
}

export interface SocketEvents {
  on(event: string, listener: (value: never) => void): void;
  off(event: string, listener: (value: never) => void): void;
}

export interface WhatsAppSocket {
  events: SocketEvents;
  user?: { id: string; name?: string };
  end(error?: Error): void | Promise<void>;
  logout(): Promise<void>;
  onWhatsApp(...phoneNumbers: string[]): Promise<{ exists: boolean; jid: string }[]>;
  fetchMessageHistory(
    count: number,
    oldestMessageKey: WAMessageKey,
    oldestMessageTimestampMs: number,
  ): Promise<string>;
  sendMessage(
    jid: string,
    content: unknown,
    options?: { quoted?: WAMessage },
  ): Promise<WAMessage | undefined>;
}

export interface SocketFactory {
  create(): Promise<WhatsAppSocket>;
}
