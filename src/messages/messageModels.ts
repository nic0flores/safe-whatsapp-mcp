// Agent context note: Defines normalized chat/message read models plus bounded opaque pagination. Tests: test/core-identity-messages.test.mjs. Keep transport identifiers out of public read models; update this note after meaningful changes.
import type { WAMessage } from "baileys";
import { SafeWhatsAppError } from "../errors.js";
import type { MediaKind } from "./messageParser.js";

export interface ChatSummary {
  chatId: string;
  kind: "direct" | "group";
  title?: string;
  e164?: string;
  unreadCount: number;
  lastMessageAt?: string;
  latestSnippet?: string;
}

export interface StoredMessage {
  messageId: string;
  sourceId: string;
  chatId: string;
  senderE164?: string;
  fromMe: boolean;
  timestamp: string;
  text?: string;
  quotedSourceId?: string;
  editedAt?: string;
  deletedAt?: string;
  media?: { kind: MediaKind; mime?: string; filename?: string; size?: number };
}

export interface Page<T> { items: T[]; nextCursor?: string }

export interface RetainedMessage {
  message: StoredMessage;
  raw: WAMessage;
  transportChatJid: string;
}

export interface ChatRow {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  unread_count: number;
  last_message_at: number | null;
  e164: string | null;
  snippet: string | null;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  source_id: string;
  transport_chat_jid: string;
  sender_e164: string | null;
  from_me: number;
  timestamp: number;
  text: string | null;
  media_kind: MediaKind | null;
  media_mime: string | null;
  media_filename: string | null;
  media_size: number | null;
  quoted_source_id: string | null;
  edited_at: number | null;
  deleted_at: number | null;
  raw_json: string | null;
}

export function chatFromRow(row: ChatRow): ChatSummary {
  return {
    chatId: row.id,
    kind: row.kind,
    ...(row.title ? { title: row.title } : {}),
    ...(row.e164 ? { e164: row.e164 } : {}),
    unreadCount: row.unread_count,
    ...(row.last_message_at ? { lastMessageAt: safeIso(row.last_message_at) } : {}),
    ...(row.snippet ? { latestSnippet: row.snippet } : {}),
  };
}

export function messageFromRow(row: MessageRow): StoredMessage {
  return {
    messageId: row.id,
    sourceId: row.source_id,
    chatId: row.chat_id,
    ...(row.sender_e164 ? { senderE164: row.sender_e164 } : {}),
    fromMe: Boolean(row.from_me),
    timestamp: safeIso(row.timestamp),
    ...(row.text ? { text: row.text } : {}),
    ...(row.quoted_source_id ? { quotedSourceId: row.quoted_source_id } : {}),
    ...(row.edited_at ? { editedAt: safeIso(row.edited_at) } : {}),
    ...(row.deleted_at ? { deletedAt: safeIso(row.deleted_at) } : {}),
    ...(row.media_kind ? {
      media: {
        kind: row.media_kind,
        ...(row.media_mime ? { mime: row.media_mime } : {}),
        ...(row.media_filename ? { filename: row.media_filename } : {}),
        ...(row.media_size !== null ? { size: row.media_size } : {}),
      },
    } : {}),
  };
}

export function page<T, R>(rows: R[], limit: number, offset: number, convert: (row: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(convert),
    ...(hasMore ? { nextCursor: encodeCursor(offset + limit) } : {}),
  };
}

export function pageSize(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new SafeWhatsAppError("Page limit must be an integer from 1 through 200.", "invalid_pagination");
  }
  return value;
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0) throw new Error();
    return Number(value.offset);
  } catch {
    throw new SafeWhatsAppError("Pagination cursor is invalid.", "invalid_pagination");
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function safeIso(value: number): string {
  const timestamp = Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000
    ? value
    : 0;
  return new Date(timestamp).toISOString();
}
