// Agent context note: Defines staged/reviewed payloads plus resolver and acknowledged transport boundaries. Tests: test/send-service.test.mjs and test/outbound-acknowledgement.test.mjs. Every transport-relevant field must stay ID-bound, and transport outcomes must distinguish acceptance, rejection, and uncertainty; update this note after meaningful changes.
import type { OutboundMediaContent, OutboundMediaSnapshot } from "../media/types.js";

export interface DestinationInput {
  chatId?: string;
  e164?: string;
}

export interface ResolvedDestination {
  chatId: string;
  transportJid: string;
  kind: "direct" | "group";
  displayName?: string;
  e164?: string;
}

export interface DestinationResolver {
  resolve(input: DestinationInput): Promise<ResolvedDestination>;
  assertReplyTarget(chatId: string, messageId: string): Promise<void>;
}

export type OutboundSendResult =
  | { outcome: "accepted"; messageId: string }
  | { outcome: "rejected"; messageId: string; errorCode: string }
  | { outcome: "uncertain"; messageId: string };

export type BindTransportMessage = (messageId: string) => Promise<void>;

export interface WhatsAppOutboundSender {
  sendText(
    destination: ResolvedDestination,
    text: string,
    replyToMessageId?: string,
    linkPreview?: PendingLinkPreview | null,
    bindTransportMessage?: BindTransportMessage,
  ): Promise<OutboundSendResult>;
  sendMedia(
    destination: ResolvedDestination,
    media: OutboundMediaContent,
    caption?: string,
    replyToMessageId?: string,
    bindTransportMessage?: BindTransportMessage,
  ): Promise<OutboundSendResult>;
}

export interface PendingLinkPreview {
  matchedText: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  jpegThumbnailBase64?: string;
  thumbnailSha256?: string;
}

export interface PendingTextPayload {
  kind: "text";
  destination: ResolvedDestination;
  text: string;
  replyToMessageId?: string;
  /** Undefined preserves legacy Baileys behavior; null explicitly disables preview fetching. */
  linkPreview?: PendingLinkPreview | null;
}

export interface PendingMediaPayload {
  kind: "media";
  destination: ResolvedDestination;
  media: OutboundMediaSnapshot;
  caption?: string;
  replyToMessageId?: string;
}

export type PendingPayload = PendingTextPayload | PendingMediaPayload;

export type ReviewedSendInput = {
  pendingId: string;
  destination: DestinationInput;
  replyToMessageId?: string;
} & (
  | {
      kind: "text";
      text: string;
      /** Browser-reviewed sends always provide either an exact preview or explicit null. */
      linkPreview: PendingLinkPreview | null;
    }
  | {
      kind: "media";
      media: OutboundMediaSnapshot;
      caption?: string;
    }
);
export type PendingSendState =
  | "prepared"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "expired"
  | "discarded";

export interface PendingSendRecord {
  id: string;
  state: PendingSendState;
  messageKind: "text" | "media";
  destinationKind: "direct" | "group";
  /** Present only while prepared/sending, or ephemerally while cleaning a transition. */
  payload: PendingPayload | null;
  digest: string;
  approvalPreview: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  transportMessageId?: string;
  errorCode?: string;
}

export interface PreparedSend {
  pendingId: string;
  digest: string;
  expiresAt: string;
  preview: Record<string, unknown>;
  approvalPreview: string;
}

export interface SendSummary {
  pendingId: string;
  state: PendingSendState;
  messageKind: "text" | "media";
  destinationKind: "direct" | "group";
  digest: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  approvalPreview?: string;
  transportMessageId?: string;
  errorCode?: string;
}
