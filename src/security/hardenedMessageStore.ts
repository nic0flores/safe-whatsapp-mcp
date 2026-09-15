// Agent context note: Fail-closed ingress/read facade for the hardened read-only fork. It filters before SQLite and, when a cache vault is present, encrypts bounded human content before MessageStore sees it. Groups, unresolved/unauthorized LIDs, media locators, and global search are denied.
import type {
  Chat,
  ChatUpdate,
  Contact,
  GroupMetadata,
  LIDMapping,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from "baileys";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import { IdentityStore, e164FromPhoneJid, normalizeUserJid } from "../messages/identityStore.js";
import { MessageStore } from "../messages/messageStore.js";
import {
  decodeCursor,
  page,
  pageSize,
  type ChatSummary,
  type Page,
  type RetainedMessage,
  type StoredMessage,
} from "../messages/messageModels.js";
import {
  isGroupJid,
  isPhoneJid,
  isSafeMessageId,
  isUserJid,
} from "../messages/messageStoreHelpers.js";
import type { SqliteState } from "../storage/database.js";
import { DirectChatAllowlist } from "./chatAllowlist.js";
import type { CacheVault } from "./cacheVault.js";

const MAX_ENCRYPTED_TEXT_PLAINTEXT_BYTES = 47_000;
const MAX_ENCRYPTED_FILENAME_PLAINTEXT_BYTES = 240;

export class HardenedMessageStore extends MessageStore {
  private readonly allowedAliases = new Map<string, string>();

  constructor(
    state: SqliteState,
    identities: IdentityStore,
    config: Pick<SafeWhatsAppConfig, "retentionMs" | "maxMessagesPerChat">,
    private readonly allowlist: DirectChatAllowlist,
    private readonly cacheVault?: CacheVault,
  ) {
    super(state, identities, config);
  }

  override ingestHistory(input: {
    chats: (Chat | ChatUpdate)[];
    contacts: Partial<Contact>[];
    messages: WAMessage[];
    lidPnMappings?: LIDMapping[];
  }): void {
    const lidPnMappings = (input.lidPnMappings ?? []).filter((mapping) =>
      this.rememberPair(mapping.lid, mapping.pn));
    const contacts = input.contacts.filter((contact) => this.contactAllowed(contact));
    const chats = input.chats.filter((chat) => this.chatAllowed(chat.id));
    const messages = input.messages
      .filter((message) => this.messageAllowed(message))
      .map((message) => this.protectMessage(message));
    super.ingestHistory({ chats, contacts, messages, lidPnMappings });
  }

  override ingestUpsert(input: { messages: WAMessage[]; type: string }): void {
    super.ingestUpsert({
      ...input,
      messages: input.messages
        .filter((message) => this.messageAllowed(message))
        .map((message) => this.protectMessage(message)),
    });
  }

  override applyUpdates(updates: WAMessageUpdate[]): void {
    super.applyUpdates(updates
      .filter((update) => this.keyAllowed(update.key))
      .map((update) => this.protectUpdate(update)));
  }

  override applyDeletes(update: { keys: WAMessageKey[] } | { jid: string; all: true }): void {
    if ("keys" in update) {
      super.applyDeletes({ keys: update.keys.filter((key) => this.keyAllowed(key)) });
      return;
    }
    if (this.directJidAllowed(update.jid)) super.applyDeletes(update);
  }

  override upsertContacts(contacts: Partial<Contact>[]): void {
    super.upsertContacts(contacts.filter((contact) => this.contactAllowed(contact)));
  }

  override linkLidMapping(lid: string, phone: string): void {
    if (this.rememberPair(lid, phone)) super.linkLidMapping(lid, phone);
  }

  override linkUserAliases(first: string, second: string): void {
    if (this.rememberPair(first, second)) super.linkUserAliases(first, second);
  }

  override upsertChats(chats: (Chat | ChatUpdate)[]): void {
    const allowed = chats.filter((chat) => this.chatAllowed(chat.id)).map((chat) => {
      if (!chat.id || !isUserJid(chat.id)) return chat;
      const record = chat as Chat & { name?: string | null };
      const name = record.name?.trim();
      if (name) this.identities.observe({ jid: chat.id, displayName: name });
      // Direct-chat titles are represented by the encrypted identity display
      // name instead of duplicating human-readable names in chats.title.
      return { ...chat, name: undefined } as Chat | ChatUpdate;
    });
    super.upsertChats(allowed);
  }

  override deleteChats(jids: string[]): void {
    super.deleteChats(jids.filter((jid) => this.directJidAllowed(jid)));
  }

  override upsertGroups(_groups: Partial<GroupMetadata>[]): void {
    // Hardened V2 never persists group metadata.
  }

  override listChats(input: {
    limit?: number;
    cursor?: string;
    kind?: "direct" | "group";
    unreadOnly?: boolean;
  } = {}): Page<ChatSummary> {
    const result = super.listChats({ ...input, kind: "direct" });
    if (!this.cacheVault) return result;
    return {
      ...result,
      items: result.items.map((chat) => {
        const identity = chat.e164 ? this.identities.findByE164(chat.e164) : undefined;
        const latest = super.readChat({ chatId: chat.chatId, limit: 1 }).items[0];
        const decoded = latest ? this.unprotectStored(latest) : undefined;
        const { title: _cipherTitle, latestSnippet: _cipherSnippet, ...safe } = chat;
        return {
          ...safe,
          ...(identity?.displayName ? { title: identity.displayName } : {}),
          ...(decoded?.text ? { latestSnippet: decoded.text } : {}),
        };
      }),
    };
  }

  override readChat(input: { chatId: string; limit?: number; cursor?: string }): Page<StoredMessage> {
    const result = super.readChat(input);
    return this.cacheVault
      ? { ...result, items: result.items.map((message) => this.unprotectStored(message)) }
      : result;
  }

  override searchMessages(input: {
    query: string;
    chatId?: string;
    limit?: number;
    cursor?: string;
  }): Page<StoredMessage> {
    if (!this.cacheVault) return super.searchMessages(input);
    const query = input.query.trim();
    if (!query) throw new SafeWhatsAppError("Search query cannot be empty.", "invalid_search");
    if (!input.chatId) {
      throw new SafeWhatsAppError(
        "Hardened WhatsApp search requires an explicit allowlisted chatId.",
        "chat_scope_required",
      );
    }
    if (!super.resolveChat(input.chatId)) {
      throw new SafeWhatsAppError("WhatsApp chat was not found.", "chat_not_found");
    }

    const needle = query.toLocaleLowerCase();
    const matches: StoredMessage[] = [];
    let scanCursor: string | undefined;
    do {
      const batch = super.readChat({ chatId: input.chatId, limit: 200, cursor: scanCursor });
      for (const stored of batch.items) {
        const message = this.unprotectStored(stored);
        if (message.text?.toLocaleLowerCase().includes(needle)) matches.push(message);
      }
      scanCursor = batch.nextCursor;
    } while (scanCursor);

    const limit = pageSize(input.limit);
    const offset = decodeCursor(input.cursor);
    return page(matches.slice(offset, offset + limit + 1), limit, offset, (message) => message);
  }

  override getRetainedMessage(messageId: string): RetainedMessage | undefined {
    const retained = super.getRetainedMessage(messageId);
    if (!retained || !this.cacheVault) return retained;
    return { ...retained, message: this.unprotectStored(retained.message) };
  }

  override retainedMediaMessageIds(): string[] {
    // Media is not part of the hardened read-only contract. Keeping the list
    // empty also causes the inbound-media reconciler to delete legacy bytes.
    return [];
  }

  override resolveChat(chatId: string): {
    chatId: string;
    transportJid: string;
    kind: "direct" | "group";
    title?: string;
    e164?: string;
  } | undefined {
    const resolved = super.resolveChat(chatId);
    if (!resolved) return undefined;
    const identity = resolved.e164 ? this.identities.findByE164(resolved.e164) : undefined;
    const { title: _persistedTitle, ...safe } = resolved;
    return {
      ...safe,
      ...(identity?.displayName ? { title: identity.displayName } : {}),
    };
  }

  override ensureDirectChat(transportJid: string): { chatId: string; transportJid: string } {
    this.assertDirectJidAllowed(transportJid);
    return super.ensureDirectChat(transportJid);
  }

  override resolveVerifiedDirectChat(
    transportJid: string,
    e164: string,
  ): { chatId: string; transportJid: string } {
    if (!this.allowlist.allowsE164(e164)) throw chatDenied();
    if (isUserJid(transportJid)) this.allowedAliases.set(normalizeUserJid(transportJid), e164);
    return super.resolveVerifiedDirectChat(transportJid, e164);
  }

  private contactAllowed(contact: Partial<Contact>): boolean {
    if (!contact.id || !isUserJid(contact.id)) return false;
    const metadata = contact as Partial<Contact> & { lid?: string; phoneNumber?: string };
    const alternates = [metadata.phoneNumber, metadata.lid].filter(
      (value): value is string => typeof value === "string" && isUserJid(value),
    );
    for (const alternate of alternates) this.rememberPair(contact.id, alternate);
    return this.directJidAllowed(contact.id) || alternates.some((jid) => this.directJidAllowed(jid));
  }

  private messageAllowed(message: WAMessage): boolean {
    const key = message.key as WAMessageKey & { remoteJidAlt?: string | null };
    return this.keyAllowed(key);
  }

  private keyAllowed(key: WAMessageKey & { remoteJidAlt?: string | null }): boolean {
    const remote = key.remoteJid;
    const alternate = key.remoteJidAlt;
    if (!remote || !isUserJid(remote) || isGroupJid(remote)) return false;
    if (alternate && isUserJid(alternate)) this.rememberPair(remote, alternate);
    return this.directJidAllowed(remote) || Boolean(alternate && this.directJidAllowed(alternate));
  }

  private chatAllowed(jid: string | null | undefined): boolean {
    return typeof jid === "string" && this.directJidAllowed(jid);
  }

  private directJidAllowed(jid: string): boolean {
    if (!isUserJid(jid) || isGroupJid(jid)) return false;
    const normalized = normalizeUserJid(jid);
    const direct = isPhoneJid(normalized) ? e164FromPhoneJid(normalized) : undefined;
    const mapped = this.allowedAliases.get(normalized) ?? this.identities.findByJid(normalized)?.e164;
    return this.allowlist.allowsE164(direct ?? mapped);
  }

  private assertDirectJidAllowed(jid: string): void {
    if (!this.directJidAllowed(jid)) throw chatDenied();
  }

  private rememberPair(first: string, second: string): boolean {
    if (!isUserJid(first) || !isUserJid(second)) return false;
    const normalizedFirst = normalizeUserJid(first);
    const normalizedSecond = normalizeUserJid(second);
    const phone = [normalizedFirst, normalizedSecond].find((jid) => isPhoneJid(jid));
    if (!phone) return false;
    const e164 = e164FromPhoneJid(phone);
    if (!this.allowlist.allowsE164(e164)) return false;
    this.allowedAliases.set(normalizedFirst, e164!);
    this.allowedAliases.set(normalizedSecond, e164!);
    return true;
  }

  private protectMessage(message: WAMessage): WAMessage {
    const sourceId = message.key.id;
    if (!this.cacheVault || !isSafeMessageId(sourceId) || !message.message) return message;
    return {
      ...message,
      message: this.protectContent(message.message, sourceId),
    } as WAMessage;
  }

  private protectUpdate(update: WAMessageUpdate): WAMessageUpdate {
    const sourceId = update.key.id;
    if (!this.cacheVault || !isSafeMessageId(sourceId) || !update.update.message) return update;
    return {
      ...update,
      update: {
        ...update.update,
        message: this.protectContent(update.update.message, sourceId),
      },
    } as WAMessageUpdate;
  }

  private protectContent<T extends Record<string, any>>(content: T, sourceId: string): T {
    if (!this.cacheVault) return content;
    const clone: Record<string, any> = { ...content };

    for (const wrapper of [
      "ephemeralMessage",
      "viewOnceMessage",
      "viewOnceMessageV2",
      "viewOnceMessageV2Extension",
      "documentWithCaptionMessage",
      "editedMessage",
    ]) {
      const node = clone[wrapper];
      if (node?.message) {
        clone[wrapper] = { ...node, message: this.protectContent(node.message, sourceId) };
        return clone as T;
      }
    }

    if (clone.protocolMessage?.editedMessage) {
      clone.protocolMessage = {
        ...clone.protocolMessage,
        editedMessage: this.protectContent(clone.protocolMessage.editedMessage, sourceId),
      };
      return clone as T;
    }

    if (typeof clone.conversation === "string" && clone.conversation) {
      clone.conversation = this.cacheVault.encrypt(
        "message_text",
        sourceId,
        boundedUtf8(clone.conversation.replace(/\u0000/g, ""), MAX_ENCRYPTED_TEXT_PLAINTEXT_BYTES),
      );
      return clone as T;
    }

    if (clone.extendedTextMessage) {
      const node = { ...clone.extendedTextMessage };
      if (typeof node.text === "string" && node.text) {
        node.text = this.cacheVault.encrypt(
          "message_text",
          sourceId,
          boundedUtf8(node.text.replace(/\u0000/g, ""), MAX_ENCRYPTED_TEXT_PLAINTEXT_BYTES),
        );
      }
      clone.extendedTextMessage = node;
      return clone as T;
    }

    for (const property of [
      "imageMessage",
      "audioMessage",
      "videoMessage",
      "documentMessage",
      "stickerMessage",
    ]) {
      if (!clone[property]) continue;
      const node = { ...clone[property] };
      if (typeof node.caption === "string" && node.caption) {
        node.caption = this.cacheVault.encrypt(
          "message_text",
          sourceId,
          boundedUtf8(node.caption.replace(/\u0000/g, ""), MAX_ENCRYPTED_TEXT_PLAINTEXT_BYTES),
        );
      }
      if (typeof node.fileName === "string" && node.fileName) {
        node.fileName = this.cacheVault.encrypt(
          "message_media_filename",
          sourceId,
          boundedUtf8(
            node.fileName.replace(/\u0000/g, ""),
            MAX_ENCRYPTED_FILENAME_PLAINTEXT_BYTES,
          ),
        );
      }
      // Hardened read-only mode never persists downloadable media capabilities.
      delete node.directPath;
      delete node.mediaKey;
      delete node.url;
      clone[property] = node;
      return clone as T;
    }

    return clone as T;
  }

  private unprotectStored(message: StoredMessage): StoredMessage {
    if (!this.cacheVault) return message;
    const text = message.text
      ? this.cacheVault.decrypt("message_text", message.sourceId, message.text)
      : undefined;
    const filename = message.media?.filename
      ? this.cacheVault.decrypt("message_media_filename", message.sourceId, message.media.filename)
      : undefined;
    return {
      ...message,
      ...(text !== undefined ? { text } : {}),
      ...(message.media ? {
        media: {
          ...message.media,
          ...(filename !== undefined ? { filename } : {}),
        },
      } : {}),
    };
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function chatDenied(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "This WhatsApp chat is not in the explicit direct-chat allowlist.",
    "chat_not_allowed",
  );
}
