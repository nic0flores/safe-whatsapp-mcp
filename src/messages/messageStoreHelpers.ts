// Agent context note: Holds bounded WhatsApp JID/message-ID and update-event normalization used by MessageStore. Tests: test/core-identity-messages.test.mjs. Accept only direct user and group chats with bounded identifiers; update this note after meaningful changes.
import { proto, type WAMessage } from "baileys";
import { SafeWhatsAppError } from "../errors.js";
import { normalizeUserJid } from "./identityStore.js";

export function isUserJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.length <= 128 &&
    /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/i.test(jid);
}

export function isPhoneJid(jid: unknown): jid is string {
  return isUserJid(jid) && /@s\.whatsapp\.net$/iu.test(jid);
}

export function isLidJid(jid: unknown): jid is string {
  return isUserJid(jid) && /@lid$/iu.test(jid);
}

export function isGroupJid(jid: unknown): jid is string {
  return typeof jid === "string" && jid.length <= 128 && /^[\d-]+@g\.us$/i.test(jid);
}

export function isSupportedChatJid(jid: unknown): jid is string {
  return isUserJid(jid) || isGroupJid(jid);
}

export function isSafeMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function normalizeChatJid(jid: string): string {
  const normalized = jid.trim().toLowerCase();
  if (isUserJid(normalized)) return normalizeUserJid(normalized);
  if (isGroupJid(normalized)) return normalized;
  throw new SafeWhatsAppError("Unsupported WhatsApp chat identifier.", "unsupported_chat");
}

export function cleanTitle(value: string | undefined): string | null {
  const clean = value?.trim();
  return clean ? clean.slice(0, 256) : null;
}

export function numericTimestamp(value: unknown, now = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && "toNumber" in value) {
    value = (value as { toNumber(): number }).toNumber();
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const milliseconds = number < 100_000_000_000 ? Math.floor(number * 1_000) : Math.floor(number);
  return normalizeMessageTimestamp(milliseconds, now);
}

export function normalizeMessageTimestamp(value: number, now: number): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.floor(value)) || value <= 0) return now;
  return value > now + 300_000 ? now : Math.floor(value);
}

export function editedContent(
  message: WAMessage["message"] | undefined | null,
): WAMessage["message"] | undefined {
  return message?.editedMessage?.message ??
    (Number(message?.protocolMessage?.type) === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
      ? message?.protocolMessage?.editedMessage
      : undefined) ??
    undefined;
}

export function isProtocolRevoke(message: WAMessage["message"] | undefined | null): boolean {
  return Number(message?.protocolMessage?.type) === proto.Message.ProtocolMessage.Type.REVOKE;
}
