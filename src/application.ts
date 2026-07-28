// Agent context note: Composes encrypted WhatsApp auth, transport, retained reads/history, staged sends, and exact MCP status/contracts. Tests: test/application.test.mjs, test/account-lifecycle.test.mjs, and package smoke. Pairing may request locked residual-state cleanup before fresh auth hydration; keep WhatsApp the only external system, one-batch history semantics, and the single staged-send path.
import type { AnyMessageContent } from "baileys";
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
import type {
  DestinationInput,
  DestinationResolver,
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
    readonly services: WhatsAppMcpServices,
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
      const sends = new WhatsAppSendService(
        new FilePendingSendStore(paths.pendingDir),
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
      await Promise.all([
        reader.reconcileMedia(),
        sends.initialize(),
      ]);
      return new SafeWhatsAppApplication(
        paths,
        config,
        core,
        inboundMedia,
        { reader, media: inboundMedia, sends },
      );
    } catch (error) {
      await core.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.core.close();
  }
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
  ): Promise<{ messageId: string }> {
    const result = await this.core.client.sendMessage(destination, { text }, replyToMessageId);
    return { messageId: result.sourceId };
  }

  async sendMedia(
    destination: ResolvedDestination,
    media: OutboundMediaContent,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<{ messageId: string }> {
    const result = await this.core.client.sendMessage(
      destination,
      mediaContent(media, caption),
      replyToMessageId,
    );
    return { messageId: result.sourceId };
  }
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
