// Agent context note: Defines public review contracts, private browser sessions, and a capability-free frozen submit summary. Tests: test/review-manager.test.mjs and test/mcp-tools.test.mjs. Never expose route/action capabilities, JIDs, transport IDs, paths, hashes, or media bytes in submittedSummary.
import type { OutboundMediaSnapshot } from "../media/types.js";
import type { PendingLinkPreview } from "../replies/types.js";

export type ReviewState =
  | "open"
  | "validating"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "expired";

export type OpenWhatsAppSendReviewInput = {
  chatId?: string;
  e164?: string;
  replyToMessageId?: string;
} & (
  | { kind: "text"; text: string }
  | { kind: "media"; outboxPath: string; caption?: string }
);

export interface OpenWhatsAppSendReviewResult {
  reviewId: string;
  state: "awaiting_human";
  expiresAt: string;
  browserOpened: true;
}

export interface WhatsAppReviewOperations {
  open(input: OpenWhatsAppSendReviewInput): Promise<OpenWhatsAppSendReviewResult>;
}

export interface ReviewGroupChoice {
  choiceId: string;
  chatId: string;
  label: string;
}

export interface ReviewLinkPreview {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  description?: string;
  jpegThumbnail?: Uint8Array;
  pending: PendingLinkPreview;
}

export interface ReviewSubmittedSummary {
  readonly recipientLabel: string;
  readonly text: string;
  readonly replyLabel?: string;
  readonly attachment?: Readonly<{
    fileName: string;
    mimeType: string;
    size: number;
    kind: "image" | "audio" | "video" | "document";
  }>;
  readonly linkPreview?: Readonly<{
    url: string;
    title: string;
    description?: string;
  }>;
  readonly completedAt?: string;
}

export interface ReviewSession {
  id: string;
  routeToken: string;
  actionToken: string;
  state: ReviewState;
  createdAt: string;
  expiresAt: string;
  fromLabel: string;
  destination: { mode: "direct"; e164: string } | { mode: "group"; groupChoiceId: string };
  groups: ReviewGroupChoice[];
  text: string;
  reply?: { messageId: string; label: string };
  media?: OutboundMediaSnapshot;
  mediaId?: string;
  linkPreview?: ReviewLinkPreview;
  previewCache: Map<string, ReviewLinkPreview>;
  previewAttempts: Set<string>;
  previewRevision: number;
  errorCode?: string;
  submittedSummary?: ReviewSubmittedSummary;
  sending?: Promise<void>;
  mutationTail?: Promise<void>;
  expiryTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
}

export interface ReviewPageState {
  reviewId: string;
  state: ReviewState;
  expiresAt: string;
  fromLabel: string;
  destination?: { mode: "direct"; e164: string } | { mode: "group"; groupChoiceId: string };
  groups?: Array<{ choiceId: string; label: string }>;
  text?: string;
  reply?: { messageId: string; label: string };
  media?: {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    kind: "image" | "audio" | "video" | "document";
    previewUrl: string;
  };
  linkPreview?: {
    id: string;
    url: string;
    title: string;
    description?: string;
    thumbnailUrl?: string;
  };
  maxMediaBytes?: number;
  submittedSummary?: ReviewSubmittedSummary;
  errorCode?: string;
}
