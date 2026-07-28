// Agent context note: Exposes authenticated reads, one-batch older-history requests, exact-E.164 destination resolution, fixed-host retained media, and outbound socket operations. Tests: test/core-session-client.test.mjs and test/history-fetcher.test.mjs. Pairing status comes only from decrypted auth state; never honor message-supplied download hosts, auto-page history, or bypass staged sends; update this note after meaningful changes.
import {
  downloadContentFromMessage,
  type DownloadableMessage,
  type MediaType,
  type WAMessage,
} from "baileys";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import { e164FromPhoneJid, normalizeE164 } from "../messages/identityStore.js";
import type {
  ChatSummary,
  MessageStore,
  Page,
  RetainedMessage,
  StoredMessage,
} from "../messages/messageStore.js";
import type { SqliteState, StateCounts } from "../storage/database.js";
import type { SessionManager, SyncCompleteness } from "./sessionManager.js";
import {
  WhatsAppHistoryFetcher,
  type FetchOlderMessagesInput,
  type FetchOlderMessagesResult,
} from "./historyFetcher.js";

export interface ClientStatus {
  paired: boolean;
  connected: boolean;
  connecting: boolean;
  syncCompleteness?: SyncCompleteness;
  lastSyncAt?: string;
  counts: StateCounts;
  retentionDays: number;
  maxMessagesPerChat: number;
  pendingTtlMinutes: number;
  connectionTimeoutSeconds: number;
  syncTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  inlineMediaBytes: number;
  maxMediaBytes: number;
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
  failureCode?: string;
}

export interface SyncedPage<T> extends Page<T> { syncCompleteness: SyncCompleteness }

export interface ResolvedDestination {
  chatId: string;
  transportJid: string;
  kind: "direct" | "group";
  e164?: string;
  title?: string;
}

export type DestinationInput = { chatId: string; e164?: never } | { e164: string; chatId?: never };

export interface OutboundResult {
  sourceId: string;
  timestamp?: string;
  syncCompleteness: SyncCompleteness;
}

export interface RetainedMediaDescriptor {
  messageId: string;
  kind: "image" | "audio" | "video" | "document" | "sticker";
  mime?: string;
  filename?: string;
  size?: number;
}

export type MediaByteStream = AsyncIterable<Buffer | Uint8Array> & {
  destroy?(error?: Error): void;
};

export type MediaDownloader = (
  message: DownloadableMessage,
  type: MediaType,
) => Promise<MediaByteStream>;

export class WhatsAppClient {
  private readonly history: WhatsAppHistoryFetcher;

  constructor(
    private readonly state: SqliteState,
    private readonly messages: MessageStore,
    private readonly sessions: SessionManager,
    private readonly config: SafeWhatsAppConfig,
    private readonly mediaDownloader: MediaDownloader = fixedHostMediaDownloader,
    private readonly paired: () => boolean = () => false,
  ) {
    this.history = new WhatsAppHistoryFetcher(state, messages, sessions, config);
  }

  status(): ClientStatus {
    const session = this.sessions.snapshot();
    return {
      paired: this.paired(),
      connected: session.connected,
      connecting: session.connecting,
      ...(session.syncCompleteness ? { syncCompleteness: session.syncCompleteness } : {}),
      ...(this.messages.lastSyncAt() ? { lastSyncAt: this.messages.lastSyncAt() } : {}),
      counts: this.state.counts(),
      retentionDays: this.config.retentionMs / 86_400_000,
      maxMessagesPerChat: this.config.maxMessagesPerChat,
      pendingTtlMinutes: this.config.pendingTtlMs / 60_000,
      connectionTimeoutSeconds: this.config.connectionTimeoutMs / 1_000,
      syncTimeoutSeconds: this.config.syncTimeoutMs / 1_000,
      idleTimeoutSeconds: this.config.idleTimeoutMs / 1_000,
      inlineMediaBytes: this.config.inlineMediaBytes,
      maxMediaBytes: this.config.maxMediaBytes,
      sendEnabled: this.config.sendEnabled,
      mediaSendEnabled: this.config.mediaSendEnabled,
      ...(session.failureCode ? { failureCode: session.failureCode } : {}),
    };
  }

  connect(): Promise<SyncCompleteness> {
    return this.sessions.connect();
  }

  async listChats(input: Parameters<MessageStore["listChats"]>[0] = {}): Promise<SyncedPage<ChatSummary>> {
    this.requirePaired();
    const syncCompleteness = await this.sessions.connect();
    return { ...this.messages.listChats(input), syncCompleteness };
  }

  async readChat(input: Parameters<MessageStore["readChat"]>[0]): Promise<SyncedPage<StoredMessage>> {
    this.requirePaired();
    const syncCompleteness = await this.sessions.connect();
    return { ...this.messages.readChat(input), syncCompleteness };
  }

  fetchOlderMessages(input: FetchOlderMessagesInput): Promise<FetchOlderMessagesResult> {
    this.requirePaired();
    return this.history.fetch(input);
  }

  async searchMessages(input: Parameters<MessageStore["searchMessages"]>[0]): Promise<SyncedPage<StoredMessage>> {
    this.requirePaired();
    const syncCompleteness = await this.sessions.connect();
    return { ...this.messages.searchMessages(input), syncCompleteness };
  }

  async getRetainedMessage(messageId: string): Promise<{
    retained?: RetainedMessage;
    syncCompleteness: SyncCompleteness;
  }> {
    this.requirePaired();
    const syncCompleteness = await this.sessions.connect();
    return { retained: this.messages.getRetainedMessage(messageId), syncCompleteness };
  }

  getRetainedMediaDescriptor(messageId: string): RetainedMediaDescriptor | undefined {
    this.requirePaired();
    const retained = this.messages.getRetainedMessage(messageId);
    const media = retained?.message.media;
    return retained && media ? { messageId, ...media } : undefined;
  }

  async downloadRetainedMedia(
    messageId: string,
    maxBytes = this.config.maxMediaBytes,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.requirePaired();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > this.config.maxMediaBytes) {
      throw new SafeWhatsAppError("Media download limit is invalid.", "invalid_media_limit");
    }
    await this.sessions.connect();
    const retained = this.messages.getRetainedMessage(messageId);
    if (!retained?.message.media) {
      throw new SafeWhatsAppError("Retained media is unavailable.", "media_unavailable");
    }
    if (retained.message.media.size && retained.message.media.size > maxBytes) {
      throw new SafeWhatsAppError("Media exceeds the configured download limit.", "media_too_large");
    }
    const downloadable = downloadableMedia(retained.raw, retained.message.media.kind);
    if (!downloadable) {
      throw new SafeWhatsAppError("Retained media is unavailable.", "media_unavailable");
    }
    const source = await this.mediaDownloader(downloadable.node, downloadable.type);
    return boundedStream(source, maxBytes);
  }

  async resolveDestination(input: DestinationInput): Promise<ResolvedDestination> {
    this.requirePaired();
    if ("chatId" in input && input.chatId) {
      const chat = this.messages.resolveChat(input.chatId);
      if (!chat) throw new SafeWhatsAppError("WhatsApp chat was not found.", "chat_not_found");
      if (chat.kind !== "group") {
        throw new SafeWhatsAppError(
          "Direct recipients must be verified using canonical +E.164.",
          "direct_destination_requires_e164",
        );
      }
      return chat;
    }
    if (!("e164" in input) || typeof input.e164 !== "string") {
      throw new SafeWhatsAppError("Exactly one destination is required.", "invalid_destination");
    }
    const e164 = normalizeE164(input.e164);
    const number = e164.slice(1);
    const result = await this.sessions.run((socket) => socket.onWhatsApp(number));
    const existing = result.value.filter((entry) => entry.exists && entry.jid);
    if (existing.length === 0) {
      throw new SafeWhatsAppError("That phone number is not registered on WhatsApp.", "destination_not_found");
    }
    const matches = existing.filter((entry) => e164FromPhoneJid(entry.jid) === e164);
    if (existing.length !== 1 || matches.length !== 1) {
      throw new SafeWhatsAppError(
        "WhatsApp returned an identity that did not match the requested phone number.",
        "destination_verification_failed",
      );
    }
    const match = matches[0]!;
    const direct = this.messages.resolveVerifiedDirectChat(match.jid, e164);
    return { ...direct, kind: "direct", e164 };
  }

  async sendMessage(
    destination: ResolvedDestination,
    content: unknown,
    replyToMessageId?: string,
  ): Promise<OutboundResult> {
    this.requirePaired();
    const quoted = replyToMessageId ? this.messages.getRetainedMessage(replyToMessageId) : undefined;
    let transportJid = destination.transportJid;
    if (replyToMessageId && !quoted) {
      throw new SafeWhatsAppError(
        "Reply target is unavailable.",
        "invalid_reply_target",
      );
    }
    if (quoted && quoted.message.chatId !== destination.chatId) {
      const replyChat = this.messages.resolveChat(quoted.message.chatId);
      const sameDirectIdentity =
        destination.kind === "direct" &&
        replyChat?.kind === "direct" &&
        Boolean(destination.e164) &&
        destination.e164 === replyChat.e164;
      if (!sameDirectIdentity) {
        throw new SafeWhatsAppError(
          "Reply target belongs to another chat.",
          "invalid_reply_target",
        );
      }
      transportJid = quoted.transportChatJid;
    }
    const result = await this.sessions.run((socket) =>
      socket.sendMessage(
        transportJid,
        content,
        quoted ? { quoted: quoted.raw } : undefined,
      ),
    );
    const sent = result.value;
    if (!sent?.key.id) {
      throw new SafeWhatsAppError("WhatsApp did not acknowledge the message.", "send_uncertain");
    }
    return {
      sourceId: sent.key.id,
      ...(messageTimestamp(sent) ? { timestamp: new Date(messageTimestamp(sent)!).toISOString() } : {}),
      syncCompleteness: result.syncCompleteness,
    };
  }

  assertReplyTarget(chatId: string, messageId: string): void {
    this.requirePaired();
    const retained = this.messages.getRetainedMessage(messageId);
    if (!retained || !this.messages.areEquivalentChats(chatId, retained.message.chatId)) {
      throw new SafeWhatsAppError(
        "Reply target is unavailable or belongs to another chat.",
        "invalid_reply_target",
      );
    }
  }

  disconnect(): Promise<void> { return this.sessions.disconnect(); }
  unlinkRemote(): Promise<void> { return this.sessions.unlink(); }

  private requirePaired(): void {
    if (!this.paired()) {
      throw new SafeWhatsAppError(
        "WhatsApp is not paired. Run `safewhatsapp connect` first.",
        "pairing_required",
      );
    }
  }
}

async function fixedHostMediaDownloader(
  message: DownloadableMessage,
  type: MediaType,
): Promise<MediaByteStream> {
  const locator = safeMediaLocator(message);
  if (!locator) {
    throw new SafeWhatsAppError("Retained media is unavailable.", "media_unavailable");
  }
  return downloadContentFromMessage(locator, type) as Promise<MediaByteStream>;
}

function downloadableMedia(
  message: WAMessage,
  kind: RetainedMediaDescriptor["kind"],
): { node: DownloadableMessage; type: MediaType } | undefined {
  let content = message.message;
  for (let depth = 0; content && depth < 6; depth += 1) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  const node = kind === "image" ? content?.imageMessage
    : kind === "audio" ? content?.audioMessage
      : kind === "video" ? content?.videoMessage
        : kind === "document" ? content?.documentMessage
          : content?.stickerMessage;
  if (!node) return undefined;
  const locator = safeMediaLocator(node);
  return locator ? { node: locator, type: kind } : undefined;
}

function safeMediaLocator(value: object): DownloadableMessage | undefined {
  const locator = value as { directPath?: unknown; mediaKey?: unknown };
  if (typeof locator.directPath !== "string" || locator.directPath.length > 4_096 ||
      !locator.directPath.startsWith("/") || locator.directPath.startsWith("//") ||
      locator.directPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(locator.directPath) ||
      !(locator.mediaKey instanceof Uint8Array) || locator.mediaKey.byteLength !== 32) {
    return undefined;
  }
  return { directPath: locator.directPath, mediaKey: locator.mediaKey };
}

async function* boundedStream(
  source: MediaByteStream,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  try {
    for await (const chunk of source) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        throw new SafeWhatsAppError("Media exceeds the configured download limit.", "media_too_large");
      }
      yield bytes;
    }
  } finally {
    source.destroy?.();
  }
}

function messageTimestamp(message: WAMessage): number | undefined {
  const value = message.messageTimestamp;
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const milliseconds = number < 100_000_000_000 ? number * 1_000 : number;
  return milliseconds > Date.now() + 300_000 || milliseconds > 8_640_000_000_000_000
    ? Date.now()
    : milliseconds;
}
