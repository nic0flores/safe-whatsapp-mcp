// Agent context note: Orchestrates staged sends with atomic claims, every-operation expiry/pruning, and orphan reconciliation. Tests: test/send-service.test.mjs. Never retry a claimed send, accept changed approval data, or retain terminal plaintext; update this note after meaningful behavior changes.
import { randomUUID } from "node:crypto";
import { SafeWhatsAppError, publicError } from "../errors.js";
import type { SendAuditSink } from "../audit/redactedAudit.js";
import type { OutboundMediaContent, OutboundMediaSnapshot } from "../media/types.js";
import { approvalPreviewFor, digestSend, publicPreview } from "./digest.js";
import type {
  DestinationInput,
  DestinationResolver,
  PendingMediaPayload,
  PendingPayload,
  PendingSendRecord,
  PreparedSend,
  SendSummary,
  WhatsAppOutboundSender,
} from "./types.js";
import type { PendingSendRepository } from "./pendingStore.js";
import { assertPayloadIntegrity } from "./recordValidation.js";

export interface OutboundMediaStager {
  snapshot(relativePath: string, pendingId: string): Promise<OutboundMediaSnapshot>;
  readVerified(snapshot: OutboundMediaSnapshot, pendingId: string): Promise<OutboundMediaContent>;
  removeSnapshot(snapshot: OutboundMediaSnapshot | undefined, pendingId: string): Promise<void>;
  reconcileSnapshots(referencedPendingIds: ReadonlySet<string>, now?: Date): Promise<string[]>;
}

export interface SendServiceOptions {
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
  pendingTtlMs: number;
  historyRetentionMs?: number;
  now?: () => Date;
}

export interface WhatsAppSendOperations {
  prepareText(input: DestinationInput & { text: string; replyToMessageId?: string }): Promise<PreparedSend>;
  prepareMedia(input: DestinationInput & { outboxPath: string; caption?: string; replyToMessageId?: string }): Promise<PreparedSend>;
  sendPrepared(input: { pendingId: string; digest: string; approvalPreview: string }): Promise<{ state: "sent"; whatsappMessageId: string }>;
  discard(pendingId: string): Promise<{ discarded: boolean }>;
  list(input?: { status?: string; limit?: number; cursor?: string }): Promise<{ sends: SendSummary[]; nextCursor?: string }>;
}

export class WhatsAppSendService implements WhatsAppSendOperations {
  private readonly now: () => Date;
  private readonly historyRetentionMs: number;
  private recovery: Promise<void> | undefined;

  constructor(
    private readonly store: PendingSendRepository,
    private readonly resolver: DestinationResolver,
    private readonly media: OutboundMediaStager,
    private readonly sender: WhatsAppOutboundSender,
    private readonly audit: SendAuditSink,
    private readonly options: SendServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.historyRetentionMs = options.historyRetentionMs ?? 30 * 86_400_000;
  }

  async initialize(): Promise<void> {
    await this.maintain();
  }

  async prepareText(
    input: DestinationInput & { text: string; replyToMessageId?: string },
  ): Promise<PreparedSend> {
    await this.maintain();
    assertDestinationInput(input);
    assertText(input.text, 4_096, "Message text");
    const destination = await this.resolver.resolve(input);
    assertDestinationResolution(input, destination);
    await this.validateReply(destination.chatId, input.replyToMessageId);
    return this.createPrepared({
      kind: "text",
      destination,
      text: input.text,
      replyToMessageId: input.replyToMessageId,
    });
  }

  async prepareMedia(
    input: DestinationInput & { outboxPath: string; caption?: string; replyToMessageId?: string },
  ): Promise<PreparedSend> {
    await this.maintain();
    assertDestinationInput(input);
    if (input.caption !== undefined) assertText(input.caption, 1_024, "Media caption", true);
    const destination = await this.resolver.resolve(input);
    assertDestinationResolution(input, destination);
    await this.validateReply(destination.chatId, input.replyToMessageId);
    const id = randomUUID();
    const snapshot = await this.media.snapshot(input.outboxPath, id);
    try {
      if (snapshot.kind === "audio" && input.caption && input.caption.length > 0) {
        throw new SafeWhatsAppError(
          "WhatsApp audio messages do not support captions. Remove the caption or send the file as a document.",
          "audio_caption_unsupported",
        );
      }
      return await this.createPrepared(
        {
          kind: "media",
          destination,
          media: snapshot,
          caption: input.caption,
          replyToMessageId: input.replyToMessageId,
        },
        id,
      );
    } catch (error) {
      await this.media.removeSnapshot(snapshot, id).catch(() => undefined);
      throw error;
    }
  }

  async sendPrepared(input: {
    pendingId: string;
    digest: string;
    approvalPreview: string;
  }): Promise<{ state: "sent"; whatsappMessageId: string }> {
    await this.maintain();
    if (!this.options.sendEnabled) {
      throw new SafeWhatsAppError(
        "Sending is disabled. Set SAFE_WHATSAPP_MCP_ENABLE_SEND=true to allow confirmed sends.",
        "send_disabled",
      );
    }
    const staged = await this.store.get(input.pendingId);
    if (!staged) throw new SafeWhatsAppError("Prepared send was not found.", "pending_send_not_found");
    if (staged.messageKind === "media" && !this.options.mediaSendEnabled) {
      throw new SafeWhatsAppError(
        "Media sending is disabled. Set SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND=true to allow confirmed media sends.",
        "media_send_disabled",
      );
    }

    let claimed: PendingSendRecord;
    try {
      claimed = await this.store.claim(
        input.pendingId,
        input.digest,
        input.approvalPreview,
        this.now(),
      );
    } catch (error) {
      if (publicError(error).code === "pending_send_expired") {
        for (const expired of await this.store.expirePrepared(this.now())) {
          await this.cleanTerminal(expired, "expire", "expired");
        }
      }
      throw error;
    }

    let transportStarted = false;
    try {
      const payload = claimed.payload;
      if (!payload) {
        throw new SafeWhatsAppError("The prepared send record is incomplete.", "pending_send_corrupt");
      }
      if (!claimed.approvalPreview) {
        throw new SafeWhatsAppError("The prepared send record is incomplete.", "pending_send_corrupt");
      }
      assertPayloadIntegrity(payload, claimed.approvalPreview, claimed.digest, claimed.id);
      const result = payload.kind === "text"
        ? await (async () => {
            transportStarted = true;
            return this.sender.sendText(
              payload.destination,
              payload.text,
              payload.replyToMessageId,
            );
          })()
        : await (async () => {
            const media = await this.media.readVerified(payload.media, claimed.id);
            transportStarted = true;
            return this.sender.sendMedia(
              payload.destination,
              media,
              payload.caption,
              payload.replyToMessageId,
            );
          })();

      const sent = await this.store.finish(claimed.id, "sent", this.now(), {
        transportMessageId: result.messageId,
      });
      await this.cleanTerminal(sent, "send", "sent");
      return { state: "sent", whatsappMessageId: result.messageId };
    } catch (error) {
      const publicFailure = publicError(error);
      const state = transportStarted ? "uncertain" : "failed";
      let terminal = claimed;
      try {
        terminal = await this.store.finish(claimed.id, state, this.now(), {
          errorCode: transportStarted ? "transport_outcome_unknown" : publicFailure.code,
        });
      } catch {
        // A persisted `sending` record is recovered as uncertain on the next service operation.
      }
      await this.cleanTerminal(
        terminal,
        "send",
        state,
        transportStarted ? "transport_outcome_unknown" : publicFailure.code,
      );
      if (transportStarted) {
        throw new SafeWhatsAppError(
          "WhatsApp may have accepted the message. Inspect the chat before preparing another send.",
          "send_uncertain",
        );
      }
      throw error;
    }
  }

  async discard(pendingId: string): Promise<{ discarded: boolean }> {
    await this.maintain();
    const discarded = await this.store.discard(pendingId, this.now());
    if (!discarded) return { discarded: false };
    await this.cleanTerminal(discarded, "discard", "discarded");
    return { discarded: true };
  }

  async list(input: { status?: string; limit?: number; cursor?: string } = {}): Promise<{
    sends: SendSummary[];
    nextCursor?: string;
  }> {
    await this.maintain();
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    let records = await this.store.list();
    if (input.status) records = records.filter((record) => record.state === input.status);
    if (input.cursor) {
      const cursorIndex = records.findIndex((record) => record.id === input.cursor);
      if (cursorIndex >= 0) records = records.slice(cursorIndex + 1);
    }
    const page = records.slice(0, limit);
    return {
      sends: page.map(sendSummary),
      nextCursor: records.length > limit ? page.at(-1)?.id : undefined,
    };
  }

  private async createPrepared(payload: PendingPayload, id = randomUUID()): Promise<PreparedSend> {
    const now = this.now();
    const approvalPreview = approvalPreviewFor(payload, id);
    const digest = digestSend(payload, approvalPreview, id);
    const record: PendingSendRecord = {
      id,
      state: "prepared",
      messageKind: payload.kind,
      destinationKind: payload.destination.kind,
      payload,
      digest,
      approvalPreview,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.pendingTtlMs).toISOString(),
    };
    await this.store.create(record);
    await this.safeAudit(record, "prepare", "prepared");
    return {
      pendingId: id,
      digest,
      expiresAt: record.expiresAt,
      preview: publicPreview(payload),
      approvalPreview,
    };
  }

  private async validateReply(chatId: string, messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    if (messageId.length > 512) {
      throw new SafeWhatsAppError("Invalid reply message ID.", "invalid_reply_target");
    }
    await this.resolver.assertReplyTarget(chatId, messageId);
  }

  private async ensureRecovered(): Promise<void> {
    this.recovery ??= (async () => {
      for (const record of await this.store.recoverSending(this.now())) {
        await this.cleanTerminal(record, "recover", "uncertain", "interrupted_send");
      }
    })();
    await this.recovery;
  }

  private async maintain(): Promise<void> {
    await this.ensureRecovered();
    await this.store.removeStaleTempArtifacts(this.now());
    for (const expired of await this.store.expirePrepared(this.now())) {
      await this.cleanTerminal(expired, "expire", "expired");
    }
    const cutoff = new Date(this.now().getTime() - this.historyRetentionMs);
    await this.store.pruneTerminal(cutoff);
    await this.audit.prune(cutoff).catch(() => undefined);
    const activeMedia = new Set(
      (await this.store.list())
        .filter((record) =>
          (record.state === "prepared" || record.state === "sending") &&
          record.messageKind === "media" &&
          record.payload?.kind === "media",
        )
        .map((record) => record.id),
    );
    await this.media.reconcileSnapshots(activeMedia, this.now());
  }

  private async cleanTerminal(
    record: PendingSendRecord,
    action: "send" | "discard" | "expire" | "recover",
    result: "sent" | "failed" | "uncertain" | "discarded" | "expired",
    errorCode?: string,
  ): Promise<void> {
    const payload = record.payload;
    await this.media
      .removeSnapshot(payload?.kind === "media" ? payload.media : undefined, record.id)
      .catch(() => undefined);
    await this.safeAudit(record, action, result, errorCode);
  }

  private async safeAudit(
    record: PendingSendRecord,
    action: "prepare" | "send" | "discard" | "expire" | "recover",
    result: "prepared" | "sent" | "failed" | "uncertain" | "discarded" | "expired",
    errorCode?: string,
  ): Promise<void> {
    await this.audit.record({
      action,
      result,
      pendingId: record.id,
      digest: record.digest,
      messageKind: record.messageKind,
      destinationKind: record.destinationKind,
      errorCode,
    }).catch(() => undefined);
  }
}

function assertDestinationInput(input: DestinationInput): void {
  if (Boolean(input.chatId) === Boolean(input.e164)) {
    throw new SafeWhatsAppError("Provide exactly one of chatId or e164.", "invalid_destination");
  }
  if (input.chatId !== undefined && (!input.chatId || input.chatId.length > 256)) {
    throw new SafeWhatsAppError("Invalid chat ID.", "invalid_destination");
  }
  if (input.e164 !== undefined && !/^\+[1-9]\d{6,14}$/u.test(input.e164)) {
    throw new SafeWhatsAppError("Destination must use canonical +E.164 format.", "invalid_destination");
  }
}

function assertText(value: string, maxLength: number, label: string, allowEmpty = false): void {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    throw new SafeWhatsAppError(`${label} must contain 1 to ${maxLength} characters.`, "invalid_message_content");
  }
}

function assertDestinationResolution(
  input: DestinationInput,
  destination: { kind: "direct" | "group" },
): void {
  if (input.e164 && destination.kind !== "direct") {
    throw new SafeWhatsAppError("An E.164 destination must resolve to a direct chat.", "invalid_destination");
  }
  if (input.chatId && destination.kind !== "group") {
    throw new SafeWhatsAppError(
      "Opaque chatId destinations are allowed only for existing groups; use +E.164 for direct messages.",
      "invalid_destination",
    );
  }
}

function sendSummary(record: PendingSendRecord): SendSummary {
  return {
    pendingId: record.id,
    state: record.state,
    messageKind: record.messageKind,
    destinationKind: record.destinationKind,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    approvalPreview: record.state === "prepared" ? record.approvalPreview ?? undefined : undefined,
    transportMessageId: record.transportMessageId,
    errorCode: record.errorCode,
  };
}
