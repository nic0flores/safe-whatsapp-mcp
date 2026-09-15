// Agent context note: Composes encrypted auth/cache reads with legacy send/review internals hard-disabled behind a general-purpose read-only MCP surface. V3 exposes direct chats globally while keeping groups and outbound tools unavailable.
import type { AnyMessageContent, WAUrlInfo } from "baileys";
import type { MasterKeyStore } from "./auth/masterKeyStore.js";
import { JsonLineAuditLogger } from "./audit/redactedAudit.js";
import { ConfigLoader, type SafeWhatsAppConfig } from "./config/config.js";
import { SafeWhatsAppError } from "./errors.js";
import {
  decodeCursor,
  page,
  pageSize,
  type ChatSummary,
  type StoredMessage,
} from "./messages/messageModels.js";
import { DirectChatAllowlist } from "./security/chatAllowlist.js";
import type {
  WhatsAppMcpServices,
  WhatsAppMediaKind,
  WhatsAppMessageOrder,
  WhatsAppReadOperations,
} from "./mcp/contracts.js";
import { InboundMediaService } from "./media/inboundMedia.js";
import { ClientMediaSource } from "./media/clientMediaSource.js";
import { OutboxMediaService } from "./media/outbox.js";
import type {
  OutboundMediaContent,
} from "./media/types.js";
import { FilePendingSendStore } from "./replies/pendingStore.js";
import { WhatsAppSendService } from "./replies/sendService.js";
import { SendReviewManager } from "./review/reviewManager.js";
import type {
  BindTransportMessage,
  DestinationInput,
  DestinationResolver,
  PendingLinkPreview,
  OutboundSendResult,
  ResolvedDestination,
  WhatsAppOutboundSender,
} from "./replies/types.js";
import { StatePaths } from "./storage/paths.js";
import { WhatsAppCore } from "./whatsapp/core.js";

export interface ApplicationOptions {
  paths?: StatePaths;
  onQr?(qr: string): void;
  onPairingAccepted?(): void;
  connectionTimeoutMs?: number;
  syncTimeoutMs?: number;
  clearResidualIfUnpaired?: boolean;
  masterKeyStore?: MasterKeyStore;
}

export class SafeWhatsAppApplication {
  private constructor(
    readonly paths: StatePaths,
    readonly config: SafeWhatsAppConfig,
    readonly core: WhatsAppCore,
    readonly inboundMedia: InboundMediaService,
    readonly reviews: SendReviewManager,
    readonly services: WhatsAppMcpServices,
    private readonly detachOutboundRejection: () => void,
    private readonly awaitOutboundRejections: () => Promise<void>,
  ) {}

  static async open(options: ApplicationOptions = {}): Promise<SafeWhatsAppApplication> {
    const paths = options.paths ?? new StatePaths();
    const config = await new ConfigLoader(paths).load();
    const core = await WhatsAppCore.open(paths, config, {
      onQr: options.onQr,
      onPairingAccepted: options.onPairingAccepted,
      connectionTimeoutMs: options.connectionTimeoutMs,
      syncTimeoutMs: options.syncTimeoutMs,
      clearResidualIfUnpaired: options.clearResidualIfUnpaired,
      masterKeyStore: options.masterKeyStore,
    });
    let detachOutboundRejection: () => void = () => undefined;
    let outboundRejections = Promise.resolve();
    try {
      const inboundSource = new ClientMediaSource(core.client);
      const inboundMedia = new InboundMediaService(
        inboundSource,
        paths.mediaDir,
        config.inlineMediaBytes,
        config.maxMediaBytes,
      );
      const outbox = new OutboxMediaService(
        paths.outboxDir,
        paths.pendingDir,
        config.maxMediaBytes,
      );
      const pendingStore = new FilePendingSendStore(paths.pendingDir);
      const sends = new WhatsAppSendService(
        pendingStore,
        new ClientDestinationResolver(core),
        outbox,
        new ClientOutboundSender(core),
        new JsonLineAuditLogger(paths.auditFile),
        {
          sendEnabled: false,
          mediaSendEnabled: false,
          pendingTtlMs: config.pendingTtlMs,
        },
      );
      const reader = new ClientReadOperations(
        core,
        inboundMedia,
        DirectChatAllowlist.fromEnvironment(),
      );
      const reviews = new SendReviewManager({
        sends,
        listCachedGroups: (selectedChatId) => cachedReviewGroups(core, selectedChatId),
        getCachedReply: (messageId) => cachedReviewReply(core, messageId),
        sendEnabled: false,
        mediaSendEnabled: false,
        maxMediaBytes: config.maxMediaBytes,
        ttlMs: config.pendingTtlMs,
        fromLabel: linkedAccountLabel(core),
      });
      const enqueueOutboundFailure = (messageId: string, errorCode: string) => {
        const reconciliation = outboundRejections.then(async () => {
          const pendingId = await sends.reconcileTransportFailure(messageId, errorCode);
          if (!pendingId) return;
          core.outboundFailures?.remove(messageId);
          await reviews.reconcileTransportFailure(pendingId);
        });
        outboundRejections = reconciliation.catch(() => undefined);
        return reconciliation;
      };
      detachOutboundRejection = core.onOutboundRejection(({ messageId, errorCode }) =>
        enqueueOutboundFailure(messageId, errorCode));
      await Promise.all([
        reader.reconcileMedia(),
        sends.initialize(),
      ]);
      core.outboundFailures?.prune(new Date(Date.now() - 30 * 86_400_000));
      for (const failure of core.outboundFailures?.list() ?? []) {
        await enqueueOutboundFailure(failure.messageId, failure.errorCode).catch(() => undefined);
      }
      return new SafeWhatsAppApplication(
        paths,
        config,
        core,
        inboundMedia,
        reviews,
        { reader, media: inboundMedia, sends, reviews },
        detachOutboundRejection,
        () => outboundRejections,
      );
    } catch (error) {
      detachOutboundRejection();
      await outboundRejections;
      await core.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.reviews.close();
    } finally {
      this.detachOutboundRejection();
      await this.awaitOutboundRejections();
      await this.core.close();
    }
  }
}

function cachedReviewGroups(core: WhatsAppCore, selectedChatId?: string): Array<{ chatId: string; title?: string }> {
  const first = core.messages.listChats({ kind: "group", limit: 100 });
  if (!selectedChatId || first.items.some((group) => group.chatId === selectedChatId)) return first.items;
  let cursor = first.nextCursor;
  while (cursor) {
    const currentPage = core.messages.listChats({ kind: "group", limit: 200, cursor });
    const selected = currentPage.items.find((group) => group.chatId === selectedChatId);
    if (selected) return [...first.items, selected];
    cursor = currentPage.nextCursor;
  }
  return first.items;
}

function cachedReviewReply(core: WhatsAppCore, messageId: string) {
  const message = core.messages.getRetainedMessage(messageId)?.message;
  if (!message) return undefined;
  const chat = core.messages.resolveChat(message.chatId);
  return {
    chatId: message.chatId,
    ...(chat?.e164 ? { chatE164: chat.e164 } : {}),
    fromMe: message.fromMe,
    ...(message.senderE164 ? { senderE164: message.senderE164 } : {}),
    timestamp: message.timestamp,
    ...(message.text ? { text: message.text } : {}),
    ...(message.media ? { mediaKind: message.media.kind } : {}),
  };
}

function linkedAccountLabel(core: WhatsAppCore): string {
  const id = core.auth.state.creds.me?.id;
  const match = typeof id === "string"
    ? /^([1-9]\d{6,14})(?::\d+)?@s\.whatsapp\.net$/u.exec(id)
    : null;
  return match ? `WhatsApp +${match[1]}` : "Linked WhatsApp profile (number unavailable)";
}

class ClientReadOperations implements WhatsAppReadOperations {
  constructor(
    private readonly core: WhatsAppCore,
    private readonly media: InboundMediaService,
    private readonly allowlist: DirectChatAllowlist,
  ) {}

  async getStatus(): Promise<Record<string, unknown>> {
    await this.reconcileMedia();
    return {
      ...this.core.client.status(),
      sendEnabled: false,
      mediaSendEnabled: false,
      credentialsAtRest: "aes-256-gcm+os-credential-vault",
      messageCacheAtRest: "aes-256-gcm+os-cache-vault",
      transport: "unofficial-baileys",
      pairingCommand: "safewhatsapp connect",
      directChatPolicy: this.allowlist.mode,
      chatAccessPolicy: this.allowlist.mode === "all"
        ? "all-direct-before-persistence"
        : "explicit-direct-e164-allowlist-before-persistence",
      ...(this.allowlist.mode === "allowlist"
        ? { allowedDirectChatCount: this.allowlist.size }
        : {}),
      groupsExposedToMcp: false,
      globalSearchEnabled: true,
      globalMessageListingEnabled: true,
      outboundToolsExposed: false,
      mediaToolsExposed: false,
    };
  }

  async listChats(input: {
    kind?: "all" | "direct" | "group";
    unreadOnly?: boolean;
    query?: string;
    activeAfter?: string;
    activeBefore?: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const syncCompleteness = await this.syncDirectChats();
    const after = optionalDate(input.activeAfter, "activeAfter");
    const before = optionalDate(input.activeBefore, "activeBefore");
    assertDateRange(after, before);
    const needle = input.query?.trim().toLocaleLowerCase();
    let chats = this.collectChats(input.unreadOnly);
    if (needle) {
      chats = chats.filter((chat) =>
        chat.title?.toLocaleLowerCase().includes(needle) ||
        chat.e164?.toLocaleLowerCase().includes(needle));
    }
    if (after !== undefined) {
      chats = chats.filter((chat) => chat.lastMessageAt && Date.parse(chat.lastMessageAt) >= after);
    }
    if (before !== undefined) {
      chats = chats.filter((chat) => chat.lastMessageAt && Date.parse(chat.lastMessageAt) <= before);
    }
    const result = paginate(chats, input.limit, input.cursor);
    await this.reconcileMedia();
    return {
      chats: result.items,
      syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async listMessages(input: {
    chatId?: string;
    after?: string;
    before?: string;
    fromMe?: boolean;
    hasAttachment?: boolean;
    mediaKind?: WhatsAppMediaKind;
    order?: WhatsAppMessageOrder;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    if (input.chatId) this.assertAllowedChat(input.chatId);
    const syncCompleteness = await this.syncDirectChats();
    const after = optionalDate(input.after, "after");
    const before = optionalDate(input.before, "before");
    assertDateRange(after, before);
    let messages = this.collectMessages(input.chatId);
    messages = filterMessages(messages, {
      after,
      before,
      fromMe: input.fromMe,
      hasAttachment: input.hasAttachment,
      mediaKind: input.mediaKind,
    });
    sortMessages(messages, input.order ?? "desc");
    const result = paginate(messages, input.limit, input.cursor);
    await this.reconcileMedia();
    return {
      messages: result.items.map((message) => this.withChatContext(message)),
      syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async readChat(input: {
    chatId: string;
    after?: string;
    before?: string;
    order?: WhatsAppMessageOrder;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    return this.listMessages({
      chatId: input.chatId,
      after: input.after,
      before: input.before,
      order: input.order,
      limit: input.limit,
      cursor: input.cursor,
    });
  }

  async fetchOlderMessages(input: {
    chatId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<Record<string, unknown>> {
    this.assertAllowedChat(input.chatId);
    const result = await this.core.client.fetchOlderMessages(input);
    await this.reconcileMedia();
    return result;
  }

  async resyncMessages(): Promise<Record<string, unknown>> {
    throw new SafeWhatsAppError(
      "Whole-account resync is not exposed by the hardened read-only surface.",
      "operation_disabled",
    );
  }

  async searchMessages(input: {
    query: string;
    chatId?: string;
    after?: string;
    before?: string;
    fromMe?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const query = input.query.trim();
    if (!query) throw new SafeWhatsAppError("Search query cannot be empty.", "invalid_search");
    if (input.chatId) this.assertAllowedChat(input.chatId);
    const syncCompleteness = await this.syncDirectChats();
    const after = optionalDate(input.after, "after");
    const before = optionalDate(input.before, "before");
    assertDateRange(after, before);
    const needle = query.toLocaleLowerCase();
    let messages = filterMessages(this.collectMessages(input.chatId), {
      after,
      before,
      fromMe: input.fromMe,
    }).filter((message) => message.text?.toLocaleLowerCase().includes(needle));
    sortMessages(messages, "desc");
    const result = paginate(messages, input.limit, input.cursor);
    await this.reconcileMedia();
    return {
      messages: result.items.map((message) => this.withChatContext(message)),
      syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async reconcileMedia(): Promise<void> {
    this.core.messages.prune();
    await this.media.reconcile(this.core.messages.retainedMediaMessageIds());
  }

  private async syncDirectChats() {
    const result = await this.core.client.listChats({ kind: "direct", limit: 1 });
    return result.syncCompleteness;
  }

  private collectChats(unreadOnly?: boolean): ChatSummary[] {
    const chats: ChatSummary[] = [];
    let cursor: string | undefined;
    do {
      const result = this.core.messages.listChats({
        kind: "direct",
        unreadOnly,
        limit: 200,
        cursor,
      });
      chats.push(...this.allowlist.filter(result.items));
      cursor = result.nextCursor;
    } while (cursor);
    return chats;
  }

  private collectMessages(chatId?: string): StoredMessage[] {
    const chats = chatId
      ? [this.core.messages.resolveChat(chatId)].filter((chat): chat is NonNullable<typeof chat> => Boolean(chat))
      : this.collectChats();
    const messages: StoredMessage[] = [];
    for (const chat of chats) {
      this.allowlist.assertAllowed(chat);
      let cursor: string | undefined;
      do {
        const result = this.core.messages.readChat({ chatId: chat.chatId, limit: 200, cursor });
        messages.push(...result.items);
        cursor = result.nextCursor;
      } while (cursor);
    }
    return messages;
  }

  private withChatContext(message: StoredMessage): Record<string, unknown> {
    const chat = this.core.messages.resolveChat(message.chatId);
    return {
      ...message,
      ...(chat ? {
        chat: {
          chatId: chat.chatId,
          kind: chat.kind,
          ...(chat.title ? { title: chat.title } : {}),
          ...(chat.e164 ? { e164: chat.e164 } : {}),
        },
      } : {}),
    };
  }

  private assertAllowedChat(chatId: string): void {
    this.allowlist.assertAllowed(this.core.messages.resolveChat(chatId));
  }
}

function optionalDate(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new SafeWhatsAppError(`${name} must be a valid ISO-8601 date or timestamp.`, "invalid_date_filter");
  }
  return parsed;
}

function assertDateRange(after: number | undefined, before: number | undefined): void {
  if (after !== undefined && before !== undefined && after > before) {
    throw new SafeWhatsAppError("after cannot be later than before.", "invalid_date_filter");
  }
}

function filterMessages(
  messages: StoredMessage[],
  input: {
    after?: number;
    before?: number;
    fromMe?: boolean;
    hasAttachment?: boolean;
    mediaKind?: WhatsAppMediaKind;
  },
): StoredMessage[] {
  return messages.filter((message) => {
    const timestamp = Date.parse(message.timestamp);
    if (input.after !== undefined && timestamp < input.after) return false;
    if (input.before !== undefined && timestamp > input.before) return false;
    if (input.fromMe !== undefined && message.fromMe !== input.fromMe) return false;
    if (input.hasAttachment !== undefined && Boolean(message.media) !== input.hasAttachment) return false;
    if (input.mediaKind !== undefined && message.media?.kind !== input.mediaKind) return false;
    return true;
  });
}

function sortMessages(messages: StoredMessage[], order: WhatsAppMessageOrder): void {
  const direction = order === "asc" ? 1 : -1;
  messages.sort((left, right) => {
    const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (time !== 0) return time * direction;
    return left.messageId.localeCompare(right.messageId) * direction;
  });
}

function paginate<T>(items: T[], limitInput: number, cursor: string | undefined) {
  const limit = pageSize(limitInput);
  const offset = decodeCursor(cursor);
  return page(items.slice(offset, offset + limit + 1), limit, offset, (item) => item);
}

class ClientDestinationResolver implements DestinationResolver {
  constructor(private readonly core: WhatsAppCore) {}

  async resolve(input: DestinationInput): Promise<ResolvedDestination> {
    const destination = input.chatId
      ? await this.core.client.resolveDestination({ chatId: input.chatId })
      : await this.core.client.resolveDestination({ e164: input.e164! });
    return {
      chatId: destination.chatId,
      transportJid: destination.transportJid,
      kind: destination.kind,
      e164: destination.e164,
      displayName: destination.title,
    };
  }

  async assertReplyTarget(chatId: string, messageId: string): Promise<void> {
    this.core.client.assertReplyTarget(chatId, messageId);
  }
}

class ClientOutboundSender implements WhatsAppOutboundSender {
  constructor(private readonly core: WhatsAppCore) {}

  async sendText(
    destination: ResolvedDestination,
    text: string,
    replyToMessageId?: string,
    linkPreview?: PendingLinkPreview | null,
    bindTransportMessage?: BindTransportMessage,
  ): Promise<OutboundSendResult> {
    const content: AnyMessageContent = {
      text,
      ...(linkPreview !== undefined
        ? { linkPreview: linkPreview === null ? null : baileysLinkPreview(linkPreview) }
        : {}),
    };
    const result = await this.core.client.sendMessage(
      destination,
      content,
      replyToMessageId,
      bindTransportMessage,
    );
    return outboundSendResult(result);
  }

  async sendMedia(
    destination: ResolvedDestination,
    media: OutboundMediaContent,
    caption?: string,
    replyToMessageId?: string,
    bindTransportMessage?: BindTransportMessage,
  ): Promise<OutboundSendResult> {
    const result = await this.core.client.sendMessage(
      destination,
      mediaContent(media, caption),
      replyToMessageId,
      bindTransportMessage,
    );
    return outboundSendResult(result);
  }
}

function outboundSendResult(result: Awaited<ReturnType<WhatsAppCore["client"]["sendMessage"]>>): OutboundSendResult {
  return result.outcome === "rejected"
    ? { outcome: "rejected", messageId: result.sourceId, errorCode: result.errorCode }
    : { outcome: result.outcome, messageId: result.sourceId };
}

function baileysLinkPreview(preview: PendingLinkPreview): WAUrlInfo {
  return {
    "matched-text": preview.matchedText,
    "canonical-url": preview.canonicalUrl,
    title: preview.title,
    ...(preview.description !== undefined ? { description: preview.description } : {}),
    ...(preview.jpegThumbnailBase64 !== undefined
      ? { jpegThumbnail: Buffer.from(preview.jpegThumbnailBase64, "base64") }
      : {}),
  };
}

function mediaContent(media: OutboundMediaContent, caption: string | undefined): AnyMessageContent {
  const bytes = Buffer.from(media.bytes);
  switch (media.kind) {
    case "image":
      return { image: bytes, mimetype: media.mimeType, ...(caption ? { caption } : {}) };
    case "video":
      return { video: bytes, mimetype: media.mimeType, ...(caption ? { caption } : {}) };
    case "audio":
      return { audio: bytes, mimetype: media.mimeType, ptt: false };
    case "document":
      return {
        document: bytes,
        mimetype: media.mimeType,
        fileName: media.originalName,
        ...(caption ? { caption } : {}),
      };
  }
}
