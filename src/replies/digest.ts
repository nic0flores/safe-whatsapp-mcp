// Agent context note: Canonicalizes ID-bound staged sends and produces a bidi-safe exact human approval preview. Tests: test/send-service.test.mjs. Bind the pending ID and every send-relevant field, visibly escape invisible format controls, and never include mutable filesystem paths; update this note after meaningful behavior changes.
import { createHash } from "node:crypto";
import type { PendingPayload, ResolvedDestination } from "./types.js";

export function approvalPreviewFor(payload: PendingPayload, pendingId: string): string {
  const recipient = publicRecipient(payload.destination, false);
  const exact = payload.kind === "text"
    ? {
        pendingId,
        action: "send_whatsapp_text",
        recipient,
        replyToMessageId: payload.replyToMessageId ?? null,
        text: payload.text,
      }
    : {
        pendingId,
        action: "send_whatsapp_media",
        recipient,
        replyToMessageId: payload.replyToMessageId ?? null,
        media: {
          fileName: payload.media.originalName,
          mimeType: payload.media.mimeType,
          size: payload.media.size,
          sha256: payload.media.sha256,
        },
        caption: payload.caption ?? null,
      };
  return `Approve this exact WhatsApp send:\n${visibleApprovalJson(exact)}`;
}

export function digestSend(
  payload: PendingPayload,
  approvalPreview: string,
  pendingId: string,
): string {
  const canonical = payload.kind === "text"
    ? {
        pendingId,
        kind: payload.kind,
        destination: canonicalDestination(payload.destination),
        replyToMessageId: payload.replyToMessageId ?? null,
        text: payload.text,
        approvalPreview,
      }
    : {
        pendingId,
        kind: payload.kind,
        destination: canonicalDestination(payload.destination),
        replyToMessageId: payload.replyToMessageId ?? null,
        media: {
          originalName: payload.media.originalName,
          sha256: payload.media.sha256,
          size: payload.media.size,
          mimeType: payload.media.mimeType,
          kind: payload.media.kind,
        },
        caption: payload.caption ?? null,
        approvalPreview,
      };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function publicPreview(payload: PendingPayload): Record<string, unknown> {
  const common = {
    recipient: publicRecipient(payload.destination),
    replyToMessageId: payload.replyToMessageId ?? null,
  };
  return payload.kind === "text"
    ? { ...common, kind: "text", text: visibleText(payload.text) }
    : {
        ...common,
        kind: "media",
        fileName: visibleText(payload.media.originalName),
        mimeType: payload.media.mimeType,
        size: payload.media.size,
        sha256: payload.media.sha256,
        caption: payload.caption === undefined ? null : visibleText(payload.caption),
      };
}

function canonicalDestination(destination: ResolvedDestination): Record<string, unknown> {
  return {
    chatId: destination.chatId,
    transportJid: destination.transportJid,
    kind: destination.kind,
    e164: destination.e164 ?? null,
  };
}

function publicRecipient(
  destination: ResolvedDestination,
  escapeInvisible = true,
): Record<string, unknown> {
  return {
    chatId: destination.chatId,
    kind: destination.kind,
    displayName: destination.displayName === undefined
      ? null
      : escapeInvisible ? visibleText(destination.displayName) : destination.displayName,
    e164: destination.e164 ?? null,
  };
}

function visibleApprovalJson(value: unknown): string {
  return visibleText(JSON.stringify(value, null, 2));
}

function visibleText(value: string): string {
  return value.replace(/[\p{Bidi_Control}\p{Cf}\u0085\u2028\u2029]/gu, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}
