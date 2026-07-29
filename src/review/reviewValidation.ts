// Agent context note: Validates browser-review inputs and renders security-sensitive labels. Tests: test/review-manager.test.mjs. Keep send bodies exact, bind attachment/link/reply revisions, and expose bidirectional controls without changing outbound bytes.
import { createHash, randomBytes } from "node:crypto";
import { SafeWhatsAppError } from "../errors.js";
import type { DestinationInput } from "../replies/types.js";
import type { OpenWhatsAppSendReviewInput, ReviewSession } from "./types.js";

export interface ValidatedSend {
  destination: DestinationInput;
  pageDestination: ReviewSession["destination"];
  text: string;
  replyToMessageId?: string;
  linkPreview?: ReviewSession["linkPreview"];
}

export function validateSendBody(session: ReviewSession, value: unknown): ValidatedSend {
  if (!isRecord(value)) throw invalidRequest("invalid_request");
  const allowed = new Set(["recipientMode", "e164", "groupChoiceId", "text", "replyToMessageId", "linkPreviewId", "attachmentId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidRequest("invalid_request");
  if (value.recipientMode !== "direct" && value.recipientMode !== "group") {
    throw invalidRequest("invalid_recipient");
  }
  if (typeof value.text !== "string") throw invalidRequest("invalid_message");

  let destination: DestinationInput;
  let pageDestination: ReviewSession["destination"];
  if (value.recipientMode === "direct") {
    if (typeof value.e164 !== "string" || !/^\+[1-9]\d{6,14}$/u.test(value.e164) || value.groupChoiceId !== undefined) {
      throw invalidRequest("invalid_recipient");
    }
    destination = { e164: value.e164 };
    pageDestination = { mode: "direct", e164: value.e164 };
  } else {
    if (typeof value.groupChoiceId !== "string" || value.e164 !== undefined) {
      throw invalidRequest("invalid_recipient");
    }
    const group = session.groups.find((choice) => choice.choiceId === value.groupChoiceId);
    if (!group) throw invalidRequest("invalid_recipient");
    destination = { chatId: group.chatId };
    pageDestination = { mode: "group", groupChoiceId: group.choiceId };
  }

  const limit = session.media ? 1_024 : 4_096;
  if (value.text.length > limit || (!session.media && value.text.trim().length === 0)) {
    throw invalidRequest(value.text.length > limit ? "message_too_long" : "invalid_message");
  }
  if (session.media?.kind === "audio" && value.text.length > 0) {
    throw invalidRequest("audio_caption_unsupported");
  }
  if (session.media
    ? typeof value.attachmentId !== "string" || value.attachmentId !== session.mediaId
    : value.attachmentId !== null) {
    throw invalidRequest("stale_attachment");
  }
  let replyToMessageId: string | undefined;
  if (value.replyToMessageId !== undefined) {
    if (typeof value.replyToMessageId !== "string" || value.replyToMessageId !== session.reply?.messageId) {
      throw invalidRequest("invalid_reply_target");
    }
    if (!sameDestination(session.destination, pageDestination)) throw invalidRequest("invalid_reply_target");
    replyToMessageId = value.replyToMessageId;
  }

  let linkPreview: ReviewSession["linkPreview"];
  if (value.linkPreviewId !== undefined) {
    if (typeof value.linkPreviewId !== "string" || value.linkPreviewId !== session.linkPreview?.id ||
        session.linkPreview.url !== firstHttpUrl(value.text) || session.media) {
      throw invalidRequest("invalid_link_preview");
    }
    linkPreview = session.linkPreview;
  }
  return {
    destination,
    pageDestination,
    text: value.text,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(linkPreview ? { linkPreview } : {}),
  };
}

export function assertOpenInput(input: OpenWhatsAppSendReviewInput): void {
  if (!isRecord(input) || (input.kind !== "text" && input.kind !== "media")) {
    throw invalidRequest("invalid_request");
  }
  const allowed = new Set(input.kind === "text"
    ? ["kind", "chatId", "e164", "replyToMessageId", "text"]
    : ["kind", "chatId", "e164", "replyToMessageId", "outboxPath", "caption"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw invalidRequest("invalid_request");
  if (Boolean(input.chatId) === Boolean(input.e164)) throw invalidRequest("invalid_destination");
  if (input.chatId !== undefined && (!input.chatId || input.chatId.length > 256)) {
    throw invalidRequest("invalid_destination");
  }
  if (input.e164 !== undefined && !/^\+[1-9]\d{6,14}$/u.test(input.e164)) {
    throw invalidRequest("invalid_destination");
  }
  if (input.replyToMessageId !== undefined &&
      (!input.replyToMessageId || input.replyToMessageId.length > 512)) {
    throw invalidRequest("invalid_reply_target");
  }
  if (input.kind === "text") {
    if (typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 4_096) {
      throw invalidRequest("invalid_message_content");
    }
  } else if (!input.outboxPath || input.outboxPath.length > 1_024 ||
      (input.caption !== undefined && input.caption.length > 1_024)) {
    throw invalidRequest("invalid_message_content");
  }
}

export function safeLabel(value: string | undefined): string | undefined {
  const clean = value?.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!clean) return undefined;
  let visible = "";
  for (const character of clean) {
    const replacement = visibleBidiControls(character);
    if (visible.length + replacement.length > 140) break;
    visible += replacement;
  }
  return visible || undefined;
}

export function visibleBidiControls(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0)!;
    return isBidiControl(code)
      ? `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`
      : character;
  }).join("");
}

export function groupDisambiguator(chatId: string): string {
  const local = chatId.split("@", 1)[0]!.replace(/[^A-Za-z0-9]/gu, "");
  return (local || createHash("sha256").update(chatId).digest("hex")).slice(-6);
}

export function secret(): string {
  return randomBytes(32).toString("base64url");
}

export function invalidRequest(code: string): SafeWhatsAppError {
  return new SafeWhatsAppError("The WhatsApp review request is invalid.", code);
}

function sameDestination(left: ReviewSession["destination"], right: ReviewSession["destination"]): boolean {
  return left.mode === right.mode && (left.mode === "direct"
    ? left.e164 === (right as { mode: "direct"; e164: string }).e164
    : left.groupChoiceId === (right as { mode: "group"; groupChoiceId: string }).groupChoiceId);
}

function firstHttpUrl(value: string): string | undefined {
  const match = value.match(/(?:^|[^A-Za-z0-9@])((?:https?:\/\/|www\.)[^\s<>"']+)/iu);
  return match?.[1].replace(/[),.!?;:\]}]+$/u, "");
}

function isBidiControl(code: number): boolean {
  return code === 0x061c || code === 0x200e || code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
