// Agent context note: Owns editable send reviews, browser-only transport release, and a frozen capability-free submitted summary that survives cleanup. Tests: test/review-manager.test.mjs and test/review-http-server.test.mjs. Terminal reviews must retain only safe display metadata, clean media, and release the broker lease.
import { createHash, randomUUID } from "node:crypto";
import { SafeWhatsAppError, publicError } from "../errors.js";
import type { OutboundMediaContent } from "../media/types.js";
import type { WhatsAppSendOperations } from "../replies/sendService.js";
import type { PendingLinkPreview, ReviewedSendInput } from "../replies/types.js";
import { openLocalBrowser } from "../qr/openBrowser.js";
import { fetchLinkPreview, type LinkPreviewCard } from "./linkPreview.js";
import { ReviewHttpServer, type ReviewHttpDelegate } from "./reviewHttpServer.js";
import {
  assertOpenInput,
  groupDisambiguator,
  invalidRequest,
  safeLabel,
  secret,
  validateSendBody,
  visibleBidiControls,
  type ValidatedSend,
} from "./reviewValidation.js";
import type {
  OpenWhatsAppSendReviewInput,
  OpenWhatsAppSendReviewResult,
  ReviewGroupChoice,
  ReviewPageState,
  ReviewSession,
  ReviewSubmittedSummary,
  WhatsAppReviewOperations,
} from "./types.js";

const DEFAULT_MAX_REVIEWS = 5;
const DEFAULT_TERMINAL_RETENTION_MS = 60_000;
const MAX_PREVIEW_ATTEMPTS = 5;

export interface CachedReviewGroup {
  chatId: string;
  title?: string;
}

export interface CachedReviewReply {
  chatId: string;
  chatE164?: string;
  fromMe: boolean;
  senderE164?: string;
  timestamp: string;
  text?: string;
  mediaKind?: "image" | "audio" | "video" | "document" | "sticker";
}

export interface SendReviewManagerOptions {
  sends: WhatsAppSendOperations;
  listCachedGroups(selectedChatId?: string): Promise<readonly CachedReviewGroup[]> | readonly CachedReviewGroup[];
  getCachedReply(messageId: string): Promise<CachedReviewReply | undefined> | CachedReviewReply | undefined;
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
  maxMediaBytes: number;
  ttlMs: number;
  maxReviews?: number;
  terminalRetentionMs?: number;
  now?: () => Date;
  openBrowser?: (url: string) => Promise<boolean>;
  fetchPreview?: (url: string) => Promise<LinkPreviewCard>;
  fromLabel?: string;
}

export class SendReviewManager implements WhatsAppReviewOperations, ReviewHttpDelegate {
  private readonly sessionsByRoute = new Map<string, ReviewSession>();
  private readonly sessionsById = new Map<string, ReviewSession>();
  private readonly server: ReviewHttpServer;
  private readonly now: () => Date;
  private readonly openBrowser: (url: string) => Promise<boolean>;
  private readonly fetchPreview: (url: string) => Promise<LinkPreviewCard>;
  private readonly maxReviews: number;
  private readonly terminalRetentionMs: number;
  private readonly fromLabel: string;
  private inFlightOpens = 0;
  private closing = false;
  onIdle?: () => void;

  constructor(private readonly options: SendReviewManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.openBrowser = options.openBrowser ?? openLocalBrowser;
    this.fetchPreview = options.fetchPreview ?? fetchLinkPreview;
    this.maxReviews = options.maxReviews ?? DEFAULT_MAX_REVIEWS;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.fromLabel = options.fromLabel ?? "Your linked personal WhatsApp";
    this.server = new ReviewHttpServer(this, options.maxMediaBytes);
  }

  get sessionCount(): number {
    return this.sessionsById.size;
  }

  async open(input: OpenWhatsAppSendReviewInput): Promise<OpenWhatsAppSendReviewResult> {
    if (this.closing) throw new SafeWhatsAppError("Safe WhatsApp is shutting down.", "review_unavailable");
    assertOpenInput(input);
    if (!this.options.sendEnabled) {
      throw new SafeWhatsAppError(
        "Sending is disabled. Run safewhatsapp setup-codex --enable-send first.",
        "send_disabled",
      );
    }
    if (input.kind === "media" && !this.options.mediaSendEnabled) {
      throw new SafeWhatsAppError(
        "Media sending is disabled. Enable both send gates in the Safe WhatsApp setup.",
        "media_send_disabled",
      );
    }
    if (this.sessionsById.size + this.inFlightOpens >= this.maxReviews) {
      throw new SafeWhatsAppError(
        "Too many WhatsApp reviews are already open. Finish or cancel one and retry.",
        "review_limit_reached",
      );
    }

    this.inFlightOpens += 1;
    try {
      const id = randomUUID();
      const groups = await this.groupChoices(input.chatId);
      const selectedGroup = input.chatId
        ? groups.find((group) => group.chatId === input.chatId)!
        : undefined;
      const reply = input.replyToMessageId
        ? await this.reviewReply(input.replyToMessageId, input.chatId, input.e164)
        : undefined;
      const created = this.now();
      const session: ReviewSession = {
        id,
        routeToken: secret(),
        actionToken: secret(),
        state: "open",
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + this.options.ttlMs).toISOString(),
        fromLabel: this.fromLabel,
        destination: input.e164
          ? { mode: "direct", e164: input.e164 }
          : { mode: "group", groupChoiceId: selectedGroup!.choiceId },
        groups,
        text: input.kind === "text" ? input.text : input.caption ?? "",
        ...(reply ? { reply } : {}),
        previewCache: new Map(),
        previewAttempts: new Set(),
        previewRevision: 0,
      };

      try {
        if (input.kind === "media") {
          session.media = await this.options.sends.stageReviewMedia({
            pendingId: id,
            outboxPath: input.outboxPath,
          });
          session.mediaId = secret();
          if (session.media.kind === "audio" && session.text) {
            throw new SafeWhatsAppError(
              "WhatsApp audio messages do not support captions.",
              "audio_caption_unsupported",
            );
          }
        }
        await this.server.start();
        this.addSession(session);
        if (!await this.openBrowser(this.server.urlFor(session))) {
          throw new SafeWhatsAppError(
            "Safe WhatsApp could not open the private review page.",
            "browser_open_failed",
          );
        }
        return {
          reviewId: id,
          state: "awaiting_human",
          expiresAt: session.expiresAt,
          browserOpened: true,
        };
      } catch (error) {
        await this.removeSession(session, true);
        throw error;
      }
    } finally {
      this.inFlightOpens -= 1;
      this.notifyIfIdle();
    }
  }

  findByRoute(routeToken: string): ReviewSession | undefined {
    return this.sessionsByRoute.get(routeToken);
  }

  pageState(session: ReviewSession): ReviewPageState {
    this.expireIfNeeded(session);
    const outcome = {
      reviewId: session.id,
      state: session.state,
      expiresAt: session.expiresAt,
      fromLabel: session.fromLabel,
      ...(session.submittedSummary ? { submittedSummary: session.submittedSummary } : {}),
      ...(session.errorCode ? { errorCode: session.errorCode } : {}),
    } satisfies ReviewPageState;
    if (session.state !== "open") return outcome;
    const base = `/review/${session.routeToken}/`;
    return {
      ...outcome,
      destination: session.destination,
      groups: session.groups.map(({ choiceId, label }) => ({ choiceId, label })),
      text: session.text,
      ...(session.reply ? { reply: session.reply } : {}),
      ...(session.media
        ? {
            media: {
              id: session.mediaId!,
              fileName: session.media.originalName,
              mimeType: session.media.mimeType,
              size: session.media.size,
              kind: session.media.kind,
              previewUrl: `${base}attachment`,
            },
          }
        : {}),
      ...(session.linkPreview
        ? {
            linkPreview: {
              id: session.linkPreview.id,
              url: session.linkPreview.url,
              title: session.linkPreview.title,
              ...(session.linkPreview.description
                ? { description: session.linkPreview.description }
                : {}),
              ...(session.linkPreview.jpegThumbnail
                ? { thumbnailUrl: `${base}link-thumbnail` }
                : {}),
            },
          }
        : {}),
      maxMediaBytes: this.options.maxMediaBytes,
    };
  }

  async loadPreview(session: ReviewSession, url: string): Promise<void> {
    return this.serialize(session, async () => {
      this.assertOpen(session);
      if (url.length === 0 || url.length > 2_048) throw invalidRequest("invalid_url");
      const cached = session.previewCache.get(url);
      if (cached) {
        session.linkPreview = cached;
        return;
      }
      if (!session.previewAttempts.has(url) && session.previewAttempts.size >= MAX_PREVIEW_ATTEMPTS) {
        throw new SafeWhatsAppError("This review reached its link-preview limit.", "preview_limit_reached");
      }
      session.previewAttempts.add(url);
      const revision = ++session.previewRevision;
      try {
        const card = await this.fetchPreview(previewRequestUrl(url));
        if (session.state !== "open" || revision !== session.previewRevision) return;
        const jpegThumbnail = card.jpegThumbnail;
        const pending: PendingLinkPreview = {
          matchedText: url,
          canonicalUrl: card.finalUrl,
          title: card.title,
          ...(card.description ? { description: card.description } : {}),
          ...(jpegThumbnail
            ? {
                jpegThumbnailBase64: Buffer.from(jpegThumbnail).toString("base64"),
                thumbnailSha256: createHash("sha256").update(jpegThumbnail).digest("hex"),
              }
            : {}),
        };
        const preview = {
          id: randomUUID(),
          url,
          finalUrl: card.finalUrl,
          title: card.title,
          ...(card.description ? { description: card.description } : {}),
          ...(jpegThumbnail ? { jpegThumbnail } : {}),
          pending,
        };
        session.previewCache.set(url, preview);
        session.linkPreview = preview;
      } catch {
        if (revision === session.previewRevision) session.linkPreview = undefined;
        throw new SafeWhatsAppError("The link preview could not be loaded safely.", "preview_unavailable");
      }
    });
  }

  async replaceAttachment(session: ReviewSession, bytes: Uint8Array, fileName: string): Promise<void> {
    return this.serialize(session, async () => {
      this.assertOpen(session);
      if (!this.options.mediaSendEnabled) throw invalidRequest("media_send_disabled");
      if (bytes.byteLength === 0) throw invalidRequest("unsupported_media");
      const replacement = await this.options.sends.replaceReviewMedia({
        pendingId: session.id,
        bytes,
        fileName,
      });
      if (session.state !== "open") {
        await this.options.sends.removeReviewMedia({ pendingId: session.id, snapshot: replacement }).catch(() => undefined);
        this.assertOpen(session);
      }
      session.media = replacement;
      session.mediaId = secret();
      session.linkPreview = undefined;
      if (session.media.kind === "audio") session.text = "";
    });
  }

  async removeAttachment(session: ReviewSession): Promise<void> {
    return this.serialize(session, async () => {
      this.assertOpen(session);
      if (!session.media) return;
      const media = session.media;
      await this.options.sends.removeReviewMedia({ pendingId: session.id, snapshot: media });
      session.media = undefined;
      session.mediaId = undefined;
    });
  }

  async readAttachment(session: ReviewSession): Promise<OutboundMediaContent> {
    if (!session.media) throw invalidRequest("attachment_not_found");
    return this.options.sends.readReviewMedia({ pendingId: session.id, snapshot: session.media });
  }

  async cancel(session: ReviewSession): Promise<void> {
    return this.serialize(session, async () => {
      this.assertOpen(session);
      session.state = "cancelled";
      await this.finishSession(session);
    });
  }

  async send(session: ReviewSession, body: unknown): Promise<void> {
    return this.serialize(session, async () => {
      this.assertOpen(session);
      const final = validateSendBody(session, body);
      const submittedSummary = freezeSubmittedSummary(session, final);
      session.state = "validating";
      session.destination = final.pageDestination;
      session.text = final.text;
      session.reply = final.replyToMessageId
        ? { messageId: final.replyToMessageId, label: session.reply?.label ?? "Original WhatsApp message" }
        : undefined;
      session.linkPreview = final.linkPreview;
      session.submittedSummary = submittedSummary;
      session.state = "sending";
      const reviewed: ReviewedSendInput = session.media
        ? {
            pendingId: session.id,
            kind: "media",
            destination: final.destination,
            media: session.media,
            ...(final.text ? { caption: final.text } : {}),
            ...(final.replyToMessageId ? { replyToMessageId: final.replyToMessageId } : {}),
          }
        : {
            pendingId: session.id,
            kind: "text",
            destination: final.destination,
            text: final.text,
            linkPreview: final.linkPreview?.pending ?? null,
            ...(final.replyToMessageId ? { replyToMessageId: final.replyToMessageId } : {}),
          };
      session.sending = this.runSend(session, reviewed);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const sessions = [...this.sessionsById.values()];
    await Promise.all(sessions.map((session) => this.serialize(session, async () => {
      if (session.state === "open" || session.state === "validating") session.state = "cancelled";
    })));
    await Promise.all(sessions.map((session) => session.sending?.catch(() => undefined)));
    await Promise.all(sessions.map((session) => this.removeSession(session, true)));
    await this.server.close();
  }

  private async runSend(session: ReviewSession, input: ReviewedSendInput): Promise<void> {
    try {
      await this.options.sends.sendReviewed(input);
      session.state = "sent";
    } catch (error) {
      const failure = publicError(error);
      session.state = failure.code === "send_uncertain" ? "uncertain" : "failed";
      session.errorCode = failure.code === "send_uncertain" ? "delivery_uncertain" : failure.code;
    } finally {
      if (session.submittedSummary) {
        session.submittedSummary = Object.freeze({
          ...session.submittedSummary,
          completedAt: this.now().toISOString(),
        });
      }
      await this.finishSession(session);
    }
  }

  private addSession(session: ReviewSession): void {
    this.sessionsByRoute.set(session.routeToken, session);
    this.sessionsById.set(session.id, session);
    session.expiryTimer = setTimeout(() => {
      void this.serialize(session, async () => {
        if (session.state !== "open") return;
        session.state = "expired";
        await this.finishSession(session);
      });
    }, Math.max(1, Date.parse(session.expiresAt) - this.now().getTime()));
    session.expiryTimer.unref?.();
  }

  private async groupChoices(selectedChatId?: string): Promise<ReviewGroupChoice[]> {
    const cached = await this.options.listCachedGroups(selectedChatId);
    const seen = new Set<string>();
    const groups: CachedReviewGroup[] = [];
    for (const group of cached) {
      if (!group.chatId || seen.has(group.chatId)) continue;
      const title = safeLabel(group.title);
      if (!title) continue;
      seen.add(group.chatId);
      groups.push({ chatId: group.chatId, title });
    }
    if (selectedChatId) {
      const selectedIndex = groups.findIndex((group) => group.chatId === selectedChatId);
      if (selectedIndex < 0) {
        throw new SafeWhatsAppError(
          "The selected WhatsApp group has no locally cached name and cannot be reviewed safely.",
          "review_group_unavailable",
        );
      }
      const [selected] = groups.splice(selectedIndex, 1);
      groups.unshift(selected!);
    }
    return groups.slice(0, 100).map((group) => ({
      choiceId: secret(),
      chatId: group.chatId,
      label: `${group.title} · …${groupDisambiguator(group.chatId)}`,
    }));
  }

  private async reviewReply(
    messageId: string,
    chatId?: string,
    e164?: string,
  ): Promise<{ messageId: string; label: string }> {
    const reply = await this.options.getCachedReply(messageId);
    const matchesDestination = reply && (chatId ? reply.chatId === chatId : reply.chatE164 === e164);
    if (!reply || !matchesDestination) throw invalidRequest("invalid_reply_target");
    const speaker = reply.fromMe ? "You" : reply.senderE164 ?? "Contact";
    const timestamp = Number.isFinite(Date.parse(reply.timestamp))
      ? new Date(reply.timestamp).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "Time unavailable";
    const rawSnippet = reply.text?.replace(/\s+/gu, " ").trim().slice(0, 120) ||
      (reply.mediaKind ? `${reply.mediaKind[0]!.toUpperCase()}${reply.mediaKind.slice(1)} message` : "Message");
    const snippet = visibleBidiControls(rawSnippet);
    const reference = createHash("sha256").update(messageId).digest("hex").slice(0, 8);
    return { messageId, label: `${speaker} · ${timestamp} · ${snippet} · ref ${reference}` };
  }

  private assertOpen(session: ReviewSession): void {
    if (this.closing) throw invalidRequest("review_unavailable");
    this.expireIfNeeded(session);
    if (session.state === "expired") throw invalidRequest("review_expired");
    if (session.state !== "open") throw invalidRequest("review_not_open");
  }

  private expireIfNeeded(session: ReviewSession): void {
    if (session.state === "open" && Date.parse(session.expiresAt) <= this.now().getTime()) {
      session.state = "expired";
      void this.serialize(session, () => this.finishSession(session));
    }
  }

  private async finishSession(session: ReviewSession): Promise<void> {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
    session.actionToken = secret();
    if (session.media) {
      const media = session.media;
      await this.options.sends.removeReviewMedia({ pendingId: session.id, snapshot: media }).catch(() => undefined);
      session.media = undefined;
    }
    if (!session.cleanupTimer) {
      session.cleanupTimer = setTimeout(() => { void this.removeSession(session, false); }, this.terminalRetentionMs);
      session.cleanupTimer.unref?.();
    }
  }

  private async removeSession(session: ReviewSession, cleanupMedia: boolean): Promise<void> {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (cleanupMedia && session.media) {
      await this.options.sends.removeReviewMedia({
        pendingId: session.id,
        snapshot: session.media,
      }).catch(() => undefined);
      session.media = undefined;
    }
    this.sessionsByRoute.delete(session.routeToken);
    this.sessionsById.delete(session.id);
    this.notifyIfIdle();
  }

  private async serialize<T>(session: ReviewSession, operation: () => Promise<T>): Promise<T> {
    const previous = session.mutationTail ?? Promise.resolve();
    let release!: () => void;
    session.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private notifyIfIdle(): void {
    if (this.sessionsById.size !== 0 || this.inFlightOpens !== 0) return;
    this.onIdle?.();
  }
}

function freezeSubmittedSummary(
  session: ReviewSession,
  final: ValidatedSend,
): ReviewSubmittedSummary {
  const recipientLabel = submittedRecipientLabel(session, final.pageDestination);
  const attachment = session.media
    ? Object.freeze({
        fileName: session.media.originalName,
        mimeType: session.media.mimeType,
        size: session.media.size,
        kind: session.media.kind,
      })
    : undefined;
  const linkPreview = final.linkPreview
    ? Object.freeze({
        url: final.linkPreview.url,
        title: final.linkPreview.title,
        ...(final.linkPreview.description
          ? { description: final.linkPreview.description }
          : {}),
      })
    : undefined;
  return Object.freeze({
    recipientLabel,
    text: final.text,
    ...(final.replyToMessageId && session.reply
      ? { replyLabel: session.reply.label }
      : {}),
    ...(attachment ? { attachment } : {}),
    ...(linkPreview ? { linkPreview } : {}),
  });
}

function submittedRecipientLabel(
  session: ReviewSession,
  destination: ReviewSession["destination"],
): string {
  if (destination.mode === "direct") return destination.e164;
  return session.groups.find((group) => group.choiceId === destination.groupChoiceId)!.label;
}

function previewRequestUrl(value: string): string {
  return /^www\./iu.test(value) ? "https://" + value : value;
}
