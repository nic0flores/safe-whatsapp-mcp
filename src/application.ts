// Agent context note: Composes encrypted auth, retained reads, guarded resync, acknowledged sends, and broker-owned browser reviews. Tests: application/account lifecycle, message-resync, send-service, review-manager, and package smoke. Keep WhatsApp the only transport, partial history non-authoritative, and reviewed preview bytes immutable.
import type { AnyMessageContent, WAUrlInfo } from "baileys";
import type { MasterKeyStore } from "./auth/masterKeyStore.js";
import { JsonLineAuditLogger } from "./audit/redactedAudit.js";
import { ConfigLoader, type SafeWhatsAppConfig } from "./config/config.js";
import type { WhatsAppMcpServices, WhatsAppReadOperations } from "./mcp/contracts.js";
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
          sendEnabled: config.sendEnabled,
          mediaSendEnabled: config.mediaSendEnabled,
          pendingTtlMs: config.pendingTtlMs,
        },
      );
      const reader = new ClientReadOperations(core, inboundMedia);
      const reviews = new SendReviewManager({
        sends,
        listCachedGroups: (selectedChatId) => cachedReviewGroups(core, selectedChatId),
        getCachedReply: (messageId) => cachedReviewReply(core, messageId),
        sendEnabled: config.sendEnabled,
        mediaSendEnabled: config.mediaSendEnabled,
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
    const page = core.messages.listChats({ kind: "group", limit: 200, cursor });
    const selected = page.items.find((group) => group.chatId === selectedChatId);
    if (selected) return [...first.items, selected];
    cursor = page.nextCursor;
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
  ) {}

  async getStatus(): Promise<Record<string, unknown>> {
    await this.reconcileMedia();
    return {
      ...this.core.client.status(),
      credentialsAtRest: "aes-256-gcm+os-credential-vault",
      messageCacheAtRest: "plaintext-private-permissions",
      transport: "unofficial-baileys",
      pairingCommand: "safewhatsapp connect",
      outboxDirectory: this.core.state.paths.display(this.core.state.paths.outboxDir),
    };
  }

  async listChats(input: {
    kind?: "all" | "direct" | "group";
    unreadOnly?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.core.client.listChats({
      kind: input.kind === "all" ? undefined : input.kind,
      unreadOnly: input.unreadOnly,
      limit: input.limit,
      cursor: input.cursor,
    });
    await this.reconcileMedia();
    return {
      chats: result.items,
      syncCompleteness: result.syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async readChat(input: {
    chatId: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.core.client.readChat(input);
    await this.reconcileMedia();
    return {
      messages: result.items,
      syncCompleteness: result.syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async fetchOlderMessages(input: {
    chatId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.core.client.fetchOlderMessages(input);
    await this.reconcileMedia();
    return result;
  }

  async resyncMessages(): Promise<Record<string, unknown>> {
    const syncCompleteness = await this.core.client.resyncMessages();
    await this.reconcileMedia();
    return {
      outcome: "refreshed_non_authoritative",
      authoritative: false,
      appStateRefreshRequestCompleted: true,
      syncCompleteness,
      absenceReconciled: false,
      removedByAbsence: 0,
      reason: "whatsapp_authoritative_message_snapshot_unavailable",
    };
  }

  async searchMessages(input: {
    query: string;
    chatId?: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.core.client.searchMessages(input);
    await this.reconcileMedia();
    return {
      messages: result.items,
      syncCompleteness: result.syncCompleteness,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    };
  }

  async reconcileMedia(): Promise<void> {
    this.core.messages.prune();
    await this.media.reconcile(this.core.messages.retainedMediaMessageIds());
  }
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
