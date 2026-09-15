// Agent context note: Fail-closed ingress facade for the hardened read-only fork. It allows only explicitly allowlisted direct chats to reach MessageStore persistence; groups and unresolved/unauthorized LIDs are dropped before SQLite.
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
  isGroupJid,
  isPhoneJid,
  isUserJid,
} from "../messages/messageStoreHelpers.js";
import type { SqliteState } from "../storage/database.js";
import { DirectChatAllowlist } from "./chatAllowlist.js";

export class HardenedMessageStore extends MessageStore {
  private readonly allowedAliases = new Map<string, string>();

  constructor(
    state: SqliteState,
    identities: IdentityStore,
    config: Pick<SafeWhatsAppConfig, "retentionMs" | "maxMessagesPerChat">,
    private readonly allowlist: DirectChatAllowlist,
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
    const messages = input.messages.filter((message) => this.messageAllowed(message));
    super.ingestHistory({ chats, contacts, messages, lidPnMappings });
  }

  override ingestUpsert(input: { messages: WAMessage[]; type: string }): void {
    super.ingestUpsert({
      ...input,
      messages: input.messages.filter((message) => this.messageAllowed(message)),
    });
  }

  override applyUpdates(updates: WAMessageUpdate[]): void {
    super.applyUpdates(updates.filter((update) => this.keyAllowed(update.key)));
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
    super.upsertChats(chats.filter((chat) => this.chatAllowed(chat.id)));
  }

  override deleteChats(jids: string[]): void {
    super.deleteChats(jids.filter((jid) => this.directJidAllowed(jid)));
  }

  override upsertGroups(_groups: Partial<GroupMetadata>[]): void {
    // Hardened V2 never persists group metadata.
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
}

function chatDenied(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "This WhatsApp chat is not in the explicit direct-chat allowlist.",
    "chat_not_allowed",
  );
}
