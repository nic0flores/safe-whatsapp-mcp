// Agent context note: Converts Baileys messages into bounded, allowlisted persistence records. Tests: test/core-identity-messages.test.mjs. Raw persistence is limited to bounded quote content and trusted media locators; view-once, nested quote context, and unrelated envelope metadata must never survive.
import { proto, type WAMessage } from "baileys";
import { encodeBaileys } from "../auth/serialization.js";
import { isSafeMessageId, isSupportedChatJid } from "./messageStoreHelpers.js";

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";

export interface ParsedMessage {
  sourceId: string;
  remoteJid: string;
  alternateRemoteJid?: string;
  participantJid?: string;
  alternateParticipantJid?: string;
  fromMe: boolean;
  timestamp: number;
  text?: string;
  media?: { kind: MediaKind; mime?: string; filename?: string; size?: number };
  quotedSourceId?: string;
  expiresAt?: number;
  viewOnce: boolean;
  rawJson?: string;
  revokedKey?: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    id?: string | null;
  };
}

export function parseMessage(message: WAMessage): ParsedMessage | undefined {
  const sourceId = message.key.id;
  const remoteJid = message.key.remoteJid;
  if (!isSafeMessageId(sourceId) || typeof remoteJid !== "string" ||
      remoteJid.length > 128 || !message.message) return undefined;
  const key = message.key as typeof message.key & {
    remoteJidAlt?: string | null;
    participantAlt?: string | null;
  };
  const unwrapped = unwrap(message.message);
  if (!unwrapped.complete || !unwrapped.content) {
    return {
      sourceId,
      remoteJid,
      ...(safeParticipant(key.remoteJidAlt) ? { alternateRemoteJid: key.remoteJidAlt } : {}),
      fromMe: Boolean(message.key.fromMe),
      timestamp: unixMilliseconds(message.messageTimestamp),
      viewOnce: true,
    };
  }
  const { content, viewOnce } = unwrapped;
  const protocol = content.protocolMessage;
  const timestamp = unixMilliseconds(message.messageTimestamp);
  if (protocol?.key && Number(protocol.type) === proto.Message.ProtocolMessage.Type.REVOKE) {
    const revokedKey = safeRevokedKey(protocol.key);
    if (!revokedKey) return undefined;
    return {
      sourceId,
      remoteJid,
      ...(safeParticipant(key.remoteJidAlt) ? { alternateRemoteJid: key.remoteJidAlt } : {}),
      fromMe: Boolean(message.key.fromMe),
      timestamp,
      viewOnce: false,
      revokedKey,
    };
  }
  const selected = selectContent(content);
  const context = selected.context;
  const ephemeralMessage = message as WAMessage & {
    ephemeralStartTimestamp?: unknown;
    ephemeralDuration?: number | null;
  };
  const expirationSeconds =
    positiveInteger(ephemeralMessage.ephemeralDuration) ?? positiveInteger(context?.expiration);
  const ephemeralStart = optionalUnixMilliseconds(ephemeralMessage.ephemeralStartTimestamp) ?? timestamp;
  const effectiveViewOnce = viewOnce || Boolean(selected.node?.viewOnce);
  return {
    sourceId,
    remoteJid,
    ...(safeParticipant(key.remoteJidAlt) ? { alternateRemoteJid: key.remoteJidAlt } : {}),
    ...(safeParticipant(message.key.participant)
      ? { participantJid: message.key.participant! }
      : {}),
    ...(safeParticipant(key.participantAlt) ? { alternateParticipantJid: key.participantAlt } : {}),
    fromMe: Boolean(message.key.fromMe),
    timestamp,
    ...(effectiveViewOnce ? {} : selected.text ? { text: selected.text } : {}),
    ...(effectiveViewOnce || !selected.media ? {} : { media: selected.media }),
    ...(isSafeMessageId(context?.stanzaId) ? { quotedSourceId: context!.stanzaId! } : {}),
    ...(expirationSeconds ? { expiresAt: ephemeralStart + expirationSeconds * 1_000 } : {}),
    viewOnce: effectiveViewOnce,
    ...(effectiveViewOnce || (!selected.text && !selected.media)
      ? {}
      : { rawJson: encodeBaileys(minimalRawMessage(message, content)) }),
  };
}

function unwrap(root: proto.IMessage): {
  content?: proto.IMessage;
  viewOnce: boolean;
  complete: boolean;
} {
  let content = root;
  let viewOnce = false;
  const seen = new Set<object>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (seen.has(content)) return { viewOnce, complete: false };
    seen.add(content);
    if (content.ephemeralMessage) {
      if (!content.ephemeralMessage.message) return { viewOnce, complete: false };
      content = content.ephemeralMessage.message;
      continue;
    }
    const viewWrapper =
      content.viewOnceMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension;
    if (viewWrapper) {
      viewOnce = true;
      if (!viewWrapper.message) return { viewOnce, complete: false };
      content = viewWrapper.message;
      continue;
    }
    if (content.documentWithCaptionMessage) {
      if (!content.documentWithCaptionMessage.message) return { viewOnce, complete: false };
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    if (content.editedMessage) {
      if (!content.editedMessage.message) return { viewOnce, complete: false };
      content = content.editedMessage.message;
      continue;
    }
    return { content, viewOnce, complete: true };
  }
  return { viewOnce, complete: false };
}

function minimalRawMessage(message: WAMessage, content: proto.IMessage): WAMessage {
  const key = {
    remoteJid: message.key.remoteJid,
    fromMe: message.key.fromMe,
    id: message.key.id,
    ...(safeParticipant(message.key.participant) ? { participant: message.key.participant } : {}),
  };
  return {
    key,
    message: minimalContent(content),
  } as WAMessage;
}

function minimalContent(content: proto.IMessage): proto.IMessage {
  const conversation = cleanText(content.conversation);
  if (conversation) {
    return { conversation };
  }
  if (content.extendedTextMessage) {
    return {
      extendedTextMessage: {
        text: cleanText(content.extendedTextMessage.text),
      },
    };
  }
  for (const [property, node] of [
    ["imageMessage", content.imageMessage],
    ["audioMessage", content.audioMessage],
    ["videoMessage", content.videoMessage],
    ["documentMessage", content.documentMessage],
    ["stickerMessage", content.stickerMessage],
  ] as const) {
    if (node) return { [property]: minimalMediaNode(node) } as proto.IMessage;
  }
  return {};
}

function minimalMediaNode(node: object): object {
  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const directPath = safeDirectPath(source.directPath);
  const mediaKey = source.mediaKey instanceof Uint8Array && source.mediaKey.byteLength === 32
    ? source.mediaKey
    : undefined;
  const fileLength = positiveInteger(source.fileLength);
  const mimetype = boundedString(source.mimetype, 256);
  const fileName = boundedString(source.fileName, 512);
  const caption = typeof source.caption === "string" ? cleanText(source.caption) : undefined;
  if (directPath) result.directPath = directPath;
  if (mediaKey) result.mediaKey = mediaKey;
  if (fileLength) result.fileLength = fileLength;
  if (mimetype) result.mimetype = mimetype;
  if (fileName) result.fileName = fileName;
  if (caption) result.caption = caption;
  return result;
}

function safeDirectPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4_096 &&
    value.startsWith("/") && !value.startsWith("//") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\u0000/g, "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function selectContent(content: proto.IMessage): {
  node?: { viewOnce?: boolean | null };
  text?: string;
  media?: ParsedMessage["media"];
  context?: proto.IContextInfo | null;
} {
  if (content.conversation) return { text: cleanText(content.conversation) };
  if (content.extendedTextMessage) {
    const node = content.extendedTextMessage;
    return { text: cleanText(node.text), context: node.contextInfo };
  }
  if (content.imageMessage) return mediaNode("image", content.imageMessage);
  if (content.audioMessage) return mediaNode("audio", content.audioMessage);
  if (content.videoMessage) return mediaNode("video", content.videoMessage);
  if (content.documentMessage) return mediaNode("document", content.documentMessage);
  if (content.stickerMessage) return mediaNode("sticker", content.stickerMessage);
  return {};
}

function mediaNode(kind: MediaKind, node: {
  mimetype?: string | null;
  fileName?: string | null;
  fileLength?: number | bigint | { toNumber(): number } | null;
  caption?: string | null;
  contextInfo?: proto.IContextInfo | null;
  viewOnce?: boolean | null;
}) {
  const size = positiveInteger(node.fileLength);
  const mime = boundedString(node.mimetype, 256);
  const filename = boundedString(node.fileName, 512);
  return {
    node,
    text: cleanText(node.caption),
    context: node.contextInfo,
    media: {
      kind,
      ...(mime ? { mime } : {}),
      ...(filename ? { filename } : {}),
      ...(size ? { size } : {}),
    },
  };
}

function cleanText(value: string | null | undefined): string | undefined {
  return value ? value.replace(/\u0000/g, "").slice(0, 65_536) : undefined;
}

function safeParticipant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/iu.test(value);
}

function safeRevokedKey(value: proto.IMessageKey): ParsedMessage["revokedKey"] | undefined {
  if (!isSafeMessageId(value.id)) return undefined;
  if (value.remoteJid !== undefined && value.remoteJid !== null &&
      !isSupportedChatJid(value.remoteJid)) return undefined;
  const key = value as proto.IMessageKey & { remoteJidAlt?: unknown };
  return {
    id: value.id,
    ...(value.remoteJid !== undefined ? { remoteJid: value.remoteJid } : {}),
    ...(safeParticipant(key.remoteJidAlt) ? { remoteJidAlt: key.remoteJidAlt } : {}),
  };
}

export function unixMilliseconds(value: unknown): number {
  if (value === undefined || value === null) return 0;
  let numeric: number;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "bigint") numeric = Number(value);
  else if (typeof value === "object" && "toNumber" in value) {
    numeric = (value as { toNumber(): number }).toNumber();
  } else numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 100_000_000_000 ? Math.floor(numeric * 1_000) : Math.floor(numeric);
}

function optionalUnixMilliseconds(value: unknown): number | undefined {
  if (positiveInteger(value) === undefined) return undefined;
  const milliseconds = unixMilliseconds(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "object" && value !== null && "toNumber" in value) {
    value = (value as { toNumber(): number }).toNumber();
  }
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}
