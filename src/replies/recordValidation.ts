// Agent context note: Strictly validates persisted pending-send JSON, canonical previews/digests, and deterministic media paths. Tests: test/send-service.test.mjs. Reject any malformed or changed active record before it can reach transport; update this note after meaningful behavior changes.
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import type { OutboundMediaKind, OutboundMediaSnapshot } from "../media/types.js";
import { approvalPreviewFor, digestSend } from "./digest.js";
import type {
  PendingMediaPayload,
  PendingPayload,
  PendingSendRecord,
  PendingSendState,
  PendingTextPayload,
  ResolvedDestination,
} from "./types.js";

const STATES = new Set<PendingSendState>([
  "prepared", "sending", "sent", "failed", "uncertain", "expired", "discarded",
]);
const TERMINAL_STATES = new Set<PendingSendState>([
  "sent", "failed", "uncertain", "expired", "discarded",
]);
const MEDIA_KINDS = new Set<OutboundMediaKind>(["image", "audio", "video", "document"]);
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export function validatePendingSendRecord(
  value: unknown,
  expectedId: string,
  pendingDirectory: string,
): PendingSendRecord {
  const record = objectWithKeys(value, [
    "id", "state", "messageKind", "destinationKind", "payload", "digest",
    "approvalPreview", "createdAt", "updatedAt", "expiresAt",
    "transportMessageId", "errorCode",
  ]);
  if (record.id !== expectedId || !isUuid(record.id)) corrupt();
  if (typeof record.state !== "string" || !STATES.has(record.state as PendingSendState)) corrupt();
  if (record.messageKind !== "text" && record.messageKind !== "media") corrupt();
  if (record.destinationKind !== "direct" && record.destinationKind !== "group") corrupt();
  if (!isSha256(record.digest)) corrupt();
  assertIsoDate(record.createdAt);
  assertIsoDate(record.updatedAt);
  assertIsoDate(record.expiresAt);
  optionalBoundedString(record.transportMessageId, 512);
  if (record.errorCode !== undefined &&
      (typeof record.errorCode !== "string" || !/^[a-z0-9_]{1,80}$/u.test(record.errorCode))) corrupt();

  const state = record.state as PendingSendState;
  if (TERMINAL_STATES.has(state)) {
    if (record.payload !== null || record.approvalPreview !== null) corrupt();
    return record as unknown as PendingSendRecord;
  }
  if (record.payload === null || typeof record.approvalPreview !== "string" ||
      record.approvalPreview.length < 1 || record.approvalPreview.length > 32_768) corrupt();
  const payload = validatePayload(record.payload, expectedId, pendingDirectory);
  if (payload.kind !== record.messageKind || payload.destination.kind !== record.destinationKind) corrupt();
  assertPayloadIntegrity(payload, record.approvalPreview, record.digest, expectedId);
  return record as unknown as PendingSendRecord;
}

export function assertPayloadIntegrity(
  payload: PendingPayload,
  approvalPreview: string,
  digest: string,
  pendingId: string,
): void {
  if (approvalPreviewFor(payload, pendingId) !== approvalPreview ||
      digestSend(payload, approvalPreview, pendingId) !== digest) {
    corrupt();
  }
}

function validatePayload(value: unknown, pendingId: string, pendingDirectory: string): PendingPayload {
  const valueObject = requireObject(value);
  if (valueObject.kind === "text") {
    const payload = objectWithKeys(value, ["kind", "destination", "text", "replyToMessageId"]);
    const text = boundedString(payload.text, 4_096, false);
    const validated: PendingTextPayload = {
      kind: "text",
      destination: validateDestination(payload.destination),
      text,
      ...(validateReplyId(payload.replyToMessageId) ? { replyToMessageId: payload.replyToMessageId as string } : {}),
    };
    return validated;
  }
  if (valueObject.kind === "media") {
    const payload = objectWithKeys(value, ["kind", "destination", "media", "caption", "replyToMessageId"]);
    const media = validateMedia(payload.media, pendingId, pendingDirectory);
    const caption = payload.caption === undefined ? undefined : boundedString(payload.caption, 1_024, true);
    if (media.kind === "audio" && caption) corrupt();
    const validated: PendingMediaPayload = {
      kind: "media",
      destination: validateDestination(payload.destination),
      media,
      ...(caption !== undefined ? { caption } : {}),
      ...(validateReplyId(payload.replyToMessageId) ? { replyToMessageId: payload.replyToMessageId as string } : {}),
    };
    return validated;
  }
  return corrupt();
}

function validateDestination(value: unknown): ResolvedDestination {
  const destination = objectWithKeys(value, [
    "chatId", "transportJid", "kind", "displayName", "e164",
  ]);
  const chatId = boundedString(destination.chatId, 256, false);
  const transportJid = boundedString(destination.transportJid, 256, false);
  optionalBoundedString(destination.displayName, 512);
  if (destination.kind === "direct") {
    if (typeof destination.e164 !== "string" || !/^\+[1-9]\d{6,14}$/u.test(destination.e164)) corrupt();
    if (!/^[A-Za-z0-9._:+-]+@(?:s\.whatsapp\.net|lid)$/u.test(transportJid)) corrupt();
  } else if (destination.kind === "group") {
    if (destination.e164 !== undefined || !/^[A-Za-z0-9._:+-]+@g\.us$/u.test(transportJid)) corrupt();
  } else {
    corrupt();
  }
  return {
    chatId,
    transportJid,
    kind: destination.kind as "direct" | "group",
    ...(destination.displayName !== undefined ? { displayName: destination.displayName as string } : {}),
    ...(destination.e164 !== undefined ? { e164: destination.e164 as string } : {}),
  };
}

function validateMedia(value: unknown, pendingId: string, pendingDirectory: string): OutboundMediaSnapshot {
  const media = objectWithKeys(value, [
    "pendingId", "path", "originalName", "sha256", "size", "mimeType", "kind",
  ]);
  if (media.pendingId !== pendingId || !isUuid(media.pendingId)) corrupt();
  const expectedPath = path.join(path.resolve(pendingDirectory), "media", `${pendingId}.bin`);
  if (typeof media.path !== "string" || path.resolve(media.path) !== expectedPath) corrupt();
  const originalName = boundedString(media.originalName, 255, false);
  if (originalName.includes("/") || originalName.includes("\\") || /[\u0000-\u001f\u007f]/u.test(originalName)) corrupt();
  if (!isSha256(media.sha256)) corrupt();
  if (!Number.isSafeInteger(media.size) || (media.size as number) < 0 || (media.size as number) > MAX_MEDIA_BYTES) corrupt();
  const mimeType = boundedString(media.mimeType, 255, false).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)) corrupt();
  if (typeof media.kind !== "string" || !MEDIA_KINDS.has(media.kind as OutboundMediaKind)) corrupt();
  if (kindForMime(mimeType) !== media.kind) corrupt();
  return {
    pendingId,
    path: expectedPath,
    originalName,
    sha256: media.sha256 as string,
    size: media.size as number,
    mimeType,
    kind: media.kind as OutboundMediaKind,
  };
}

function objectWithKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = requireObject(value);
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) corrupt();
  return object;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return corrupt();
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0) || value.includes("\0")) {
    return corrupt();
  }
  return value;
}

function optionalBoundedString(value: unknown, max: number): void {
  if (value !== undefined) boundedString(value, max, false);
}

function validateReplyId(value: unknown): boolean {
  if (value === undefined) return false;
  boundedString(value, 512, false);
  return true;
}

function assertIsoDate(value: unknown): void {
  if (typeof value !== "string") corrupt();
  const parsed = new Date(value as string);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) corrupt();
}

function kindForMime(mimeType: string): OutboundMediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function corrupt(): never {
  throw new SafeWhatsAppError(
    "The pending send record failed its integrity check.",
    "pending_send_corrupt",
  );
}
