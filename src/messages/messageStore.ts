// Agent context note: Persists normalized chats/messages and serves bounded queries. Tests: test/core-identity-messages.test.mjs. Deletion, view-once, edits, expiry, and retention stay monotonic across PN/LID aliases.
import { randomUUID } from "node:crypto";
import {
  proto,
  type Chat,
  type ChatUpdate,
  type Contact,
  type GroupMetadata,
  type LIDMapping,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
} from "baileys";
import { decodeBaileys } from "../auth/serialization.js";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import type { SqliteState } from "../storage/database.js";
import { IdentityStore } from "./identityStore.js";
import { parseMessage } from "./messageParser.js";
import {
  chatFromRow,
  decodeCursor,
  messageFromRow,
  page,
  pageSize,
  type ChatRow,
  type ChatSummary,
  type MessageRow,
  type Page,
  type RetainedMessage,
  type StoredMessage,
} from "./messageModels.js";
import {
  cleanTitle,
  editedContent,
  isGroupJid,
  isLidJid,
  isPhoneJid,
  isSafeMessageId,
  isProtocolRevoke,
  isSupportedChatJid,
  isUserJid,
  normalizeChatJid,
  normalizeMessageTimestamp,
  numericTimestamp,
} from "./messageStoreHelpers.js";

export type { ChatSummary, Page, RetainedMessage, StoredMessage } from "./messageModels.js";

export class MessageStore {
  constructor(
    private readonly state: SqliteState,
    readonly identities: IdentityStore,
    private readonly config: Pick<SafeWhatsAppConfig, "retentionMs" | "maxMessagesPerChat">,
    private readonly now: () => number = Date.now,
  ) {}

  ingestHistory(input: {
    chats: (Chat | ChatUpdate)[];
    contacts: Partial<Contact>[];
    messages: WAMessage[];
    lidPnMappings?: LIDMapping[];
  }): void {
    this.state.db.transaction(() => {
      for (const mapping of input.lidPnMappings ?? []) {
        this.linkLidMapping(mapping.lid, mapping.pn);
      }
      this.upsertContacts(input.contacts);
      this.upsertChats(input.chats);
      for (const message of input.messages) this.upsertMessage(message, false);
      this.prune();
      this.markSync();
    })();
  }

  ingestUpsert(input: { messages: WAMessage[]; type: string }): void {
    this.state.db.transaction(() => {
      for (const message of input.messages) this.upsertMessage(message, input.type === "notify");
      this.prune();
      this.markSync();
    })();
  }

  applyUpdates(updates: WAMessageUpdate[]): void {
    this.state.db.transaction(() => {
      for (const item of updates) {
        if (
          item.update.messageStubType === proto.WebMessageInfo.StubType.REVOKE ||
          isProtocolRevoke(item.update.message)
        ) {
          const embeddedKey = isProtocolRevoke(item.update.message)
            ? item.update.message?.protocolMessage?.key ?? undefined
            : undefined;
          this.markDeleted(this.deletionKey(item.key, embeddedKey));
          continue;
        }
        const edited = editedContent(item.update.message);
        if (edited) {
          if (!item.key.remoteJid || !isSupportedChatJid(item.key.remoteJid) ||
              !isSafeMessageId(item.key.id)) continue;
          const existing = this.existingMessageLocations(item.key);
          const targets = existing.length > 0
            ? existing
            : [{ remoteJid: item.key.remoteJid, timestamp: undefined }];
          for (const target of targets) {
            const movedToAlias = Boolean(
              target.remoteJid &&
              item.key.remoteJid &&
              normalizeChatJid(target.remoteJid) !== normalizeChatJid(item.key.remoteJid),
            );
            const retargetedKey = {
              ...item.key,
              remoteJid: target.remoteJid,
              ...(movedToAlias
                ? { remoteJidAlt: item.key.remoteJid }
                : {}),
            } as WAMessageKey;
            this.upsertMessage(
              {
                key: retargetedKey,
                message: edited,
                ...(target.timestamp ? { messageTimestamp: target.timestamp / 1_000 } : {}),
              } as WAMessage,
              false,
              true,
            );
          }
        }
      }
      this.prune();
    })();
  }

  applyDeletes(update: { keys: WAMessageKey[] } | { jid: string; all: true }): void {
    const now = this.now();
    this.state.db.transaction(() => {
      if ("keys" in update) {
        for (const key of update.keys) {
          this.markDeleted(key, now);
        }
      } else {
        if (!isSupportedChatJid(update.jid)) return;
        for (const chatJid of this.equivalentChatJids(update.jid)) {
          this.recordChatClear(chatJid, now);
        }
      }
    })();
  }

  upsertContacts(contacts: Partial<Contact>[]): void {
    for (const contact of contacts) {
      if (!contact.id || !isUserJid(contact.id)) continue;
      const metadata = contact as Partial<Contact> & { lid?: string; phoneNumber?: string };
      const alternate = [metadata.phoneNumber, metadata.lid].find(
        (candidate) => candidate && isUserJid(candidate) && candidate !== contact.id &&
          isLidJid(candidate) !== isLidJid(contact.id!),
      );
      const identity = this.identities.observe({
        jid: contact.id,
        ...(alternate && isUserJid(alternate) ? { pairedJid: alternate } : {}),
        displayName: contact.notify ?? contact.name ?? contact.verifiedName ?? undefined,
      });
      this.reconcileIdentityPrivacy(identity.aliases.map((alias) => alias.jid));
    }
  }

  linkLidMapping(lid: string, phone: string): void {
    if (!isLidJid(lid) || !isPhoneJid(phone)) return;
    const identity = this.identities.linkLid(lid, phone);
    this.reconcileIdentityPrivacy(identity.aliases.map((alias) => alias.jid));
  }

  linkUserAliases(first: string, second: string): void {
    if (!isUserJid(first) || !isUserJid(second) || isLidJid(first) === isLidJid(second)) return;
    const identity = this.identities.observe({ jid: first, pairedJid: second });
    this.reconcileIdentityPrivacy(identity.aliases.map((alias) => alias.jid));
  }

  upsertChats(chats: (Chat | ChatUpdate)[]): void {
    for (const chat of chats) {
      if (!chat.id || !isSupportedChatJid(chat.id)) continue;
      const record = chat as Chat & { conversationTimestamp?: unknown; unreadCount?: number | null };
      this.ensureChat(chat.id, {
        title: record.name ?? undefined,
        unreadCount: record.unreadCount ?? undefined,
        lastMessageAt: numericTimestamp(record.conversationTimestamp, this.now()),
      });
    }
  }

  deleteChats(jids: string[]): void {
    const deleteChat = this.state.db.prepare("DELETE FROM chats WHERE transport_jid = ?");
    const deleteGroup = this.state.db.prepare("DELETE FROM groups WHERE transport_jid = ?");
    this.state.db.transaction(() => {
      for (const jid of jids) {
        if (!isSupportedChatJid(jid)) continue;
        const now = this.now();
        for (const chatJid of this.equivalentChatJids(jid)) {
          this.recordChatClear(chatJid, now);
          deleteChat.run(chatJid);
          deleteGroup.run(chatJid);
        }
      }
    })();
  }

  upsertGroups(groups: Partial<GroupMetadata>[]): void {
    for (const group of groups) {
      if (!group.id || !isGroupJid(group.id)) continue;
      this.ensureChat(group.id, { title: group.subject ?? undefined });
    }
  }

  lastSyncAt(): string | undefined {
    const row = this.state.db
      .prepare("SELECT value FROM local_meta WHERE key = 'last_sync_at'")
      .get() as { value: string } | undefined;
    return row ? new Date(Number(row.value)).toISOString() : undefined;
  }

  listChats(input: {
    limit?: number;
    cursor?: string;
    kind?: "direct" | "group";
    unreadOnly?: boolean;
  } = {}): Page<ChatSummary> {
    this.prune();
    const limit = pageSize(input.limit);
    const offset = decodeCursor(input.cursor);
    const rows = this.state.db.prepare(`
      SELECT c.id, c.kind, c.title, c.unread_count, c.last_message_at, i.e164,
        (SELECT m.text FROM messages m
         WHERE m.chat_id = c.id AND m.deleted_at IS NULL AND m.view_once = 0
           AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS snippet
      FROM chats c LEFT JOIN identities i ON i.id = c.identity_id
      WHERE (? IS NULL OR c.kind = ?)
        AND (? = 0 OR c.unread_count > 0)
      ORDER BY COALESCE(c.last_message_at, 0) DESC, c.id
      LIMIT ? OFFSET ?
    `).all(
      this.now(),
      input.kind ?? null,
      input.kind ?? null,
      input.unreadOnly ? 1 : 0,
      limit + 1,
      offset,
    ) as ChatRow[];
    return page(rows, limit, offset, chatFromRow);
  }

  readChat(input: { chatId: string; limit?: number; cursor?: string }): Page<StoredMessage> {
    this.prune();
    this.requireChat(input.chatId);
    const limit = pageSize(input.limit);
    const offset = decodeCursor(input.cursor);
    const rows = this.state.db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?
    `).all(input.chatId, this.now(), limit + 1, offset) as MessageRow[];
    return page(rows, limit, offset, messageFromRow);
  }

  searchMessages(input: {
    query: string;
    chatId?: string;
    limit?: number;
    cursor?: string;
  }): Page<StoredMessage> {
    this.prune();
    const query = input.query.trim();
    if (!query) throw new SafeWhatsAppError("Search query cannot be empty.", "invalid_search");
    if (input.chatId) this.requireChat(input.chatId);
    const limit = pageSize(input.limit);
    const offset = decodeCursor(input.cursor);
    const rows = this.state.db.prepare(`
      SELECT * FROM messages WHERE text IS NOT NULL AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
        AND instr(lower(text), lower(?)) > 0
        AND (? IS NULL OR chat_id = ?)
      ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?
    `).all(this.now(), query, input.chatId ?? null, input.chatId ?? null, limit + 1, offset) as MessageRow[];
    return page(rows, limit, offset, messageFromRow);
  }

  getRetainedMessage(messageId: string): RetainedMessage | undefined {
    this.prune();
    const row = this.state.db.prepare(`
      SELECT * FROM messages WHERE id = ? AND raw_json IS NOT NULL
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(messageId, this.now()) as MessageRow | undefined;
    return row
      ? { message: messageFromRow(row), raw: decodeBaileys<WAMessage>(row.raw_json!), transportChatJid: row.transport_chat_jid }
      : undefined;
  }

  retainedMediaMessageIds(): string[] {
    this.prune();
    return (this.state.db.prepare(`
      SELECT id FROM messages WHERE media_kind IS NOT NULL AND raw_json IS NOT NULL
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY id
    `).all(this.now()) as { id: string }[]).map((row) => row.id);
  }

  resolveChat(chatId: string): {
    chatId: string;
    transportJid: string;
    kind: "direct" | "group";
    title?: string;
    e164?: string;
  } | undefined {
    const row = this.state.db.prepare(`
      SELECT c.id, c.transport_jid, c.kind, c.title, i.e164
      FROM chats c LEFT JOIN identities i ON i.id = c.identity_id
      WHERE c.id = ?
    `).get(chatId) as {
      id: string;
      transport_jid: string;
      kind: "direct" | "group";
      title: string | null;
      e164: string | null;
    } | undefined;
    return row ? {
      chatId: row.id,
      transportJid: row.transport_jid,
      kind: row.kind,
      ...(row.title ? { title: row.title } : {}),
      ...(row.e164 ? { e164: row.e164 } : {}),
    } : undefined;
  }

  ensureDirectChat(transportJid: string): { chatId: string; transportJid: string } {
    const chatId = this.ensureChat(transportJid).id;
    return { chatId, transportJid: normalizeChatJid(transportJid) };
  }

  resolveVerifiedDirectChat(
    transportJid: string,
    e164: string,
  ): { chatId: string; transportJid: string } {
    const identity = this.identities.observe({ jid: transportJid, e164 });
    this.reconcileIdentityPrivacy(identity.aliases.map((alias) => alias.jid));
    const existing = this.state.db.prepare(`
      SELECT id, transport_jid FROM chats
      WHERE kind = 'direct' AND identity_id = ?
      ORDER BY COALESCE(last_message_at, 0) DESC, updated_at DESC, id
      LIMIT 1
    `).get(identity.id) as { id: string; transport_jid: string } | undefined;
    if (existing) return { chatId: existing.id, transportJid: existing.transport_jid };
    const chat = this.ensureChat(transportJid, { identityId: identity.id });
    return { chatId: chat.id, transportJid: normalizeChatJid(transportJid) };
  }

  areEquivalentChats(firstChatId: string, secondChatId: string): boolean {
    if (firstChatId === secondChatId) return Boolean(this.resolveChat(firstChatId));
    const first = this.resolveChat(firstChatId);
    const second = this.resolveChat(secondChatId);
    return first?.kind === "direct" &&
      second?.kind === "direct" &&
      Boolean(first.e164) &&
      first.e164 === second.e164;
  }

  prune(): void {
    const now = this.now();
    const cutoff = now - this.config.retentionMs;
    this.state.db.prepare(
      "DELETE FROM messages WHERE timestamp < ? OR created_at < ? OR (expires_at IS NOT NULL AND expires_at <= ?)",
    ).run(cutoff, cutoff, now);
    this.state.db.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY chat_id ORDER BY timestamp DESC, id DESC) AS rank
          FROM messages
        ) WHERE rank > ?
      )
    `).run(this.config.maxMessagesPerChat);
    this.state.db.prepare("DELETE FROM message_tombstones WHERE deleted_at < ?").run(cutoff);
    this.state.db.prepare("DELETE FROM chat_clear_tombstones WHERE cleared_at < ?").run(cutoff);
  }

  private markSync(): void {
    this.state.db.prepare(`
      INSERT INTO local_meta (key, value) VALUES ('last_sync_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(this.now()));
  }

  private upsertMessage(
    message: WAMessage,
    incrementUnread: boolean,
    edited = false,
  ): void {
    const parsed = parseMessage(message);
    if (!parsed || !isSupportedChatJid(parsed.remoteJid)) return;
    if (parsed.revokedKey?.id) {
      this.markDeleted(this.deletionKey(
        {
          remoteJid: parsed.remoteJid,
          remoteJidAlt: parsed.alternateRemoteJid,
          id: parsed.sourceId,
        } as WAMessageKey,
        parsed.revokedKey as WAMessageKey,
      ));
      return;
    }
    const chatJid = normalizeChatJid(parsed.remoteJid);
    const now = this.now();
    const sourceTimestampValid = Number.isSafeInteger(Math.floor(parsed.timestamp)) &&
      parsed.timestamp > 0 &&
      parsed.timestamp <= now + 300_000;
    const timestamp = normalizeMessageTimestamp(parsed.timestamp, now);
    const direct = !isGroupJid(chatJid);
    const alternate = direct ? parsed.alternateRemoteJid : parsed.alternateParticipantJid;
    const pairedAlias = (jid: string) => alternate && isUserJid(alternate) &&
      isLidJid(jid) !== isLidJid(alternate)
      ? alternate
      : undefined;
    const chatIdentity = direct
      ? this.identities.observe({
          jid: chatJid,
          ...(pairedAlias(chatJid) ? { pairedJid: pairedAlias(chatJid) } : {}),
        })
      : undefined;
    const participantIdentity = !direct && parsed.participantJid && isUserJid(parsed.participantJid)
      ? this.identities.observe({
          jid: parsed.participantJid,
          ...(pairedAlias(parsed.participantJid)
            ? { pairedJid: pairedAlias(parsed.participantJid) }
            : {}),
        })
      : undefined;
    const senderIdentity = direct
      ? parsed.fromMe ? undefined : chatIdentity
      : participantIdentity;
    for (const identity of [chatIdentity, participantIdentity]) {
      if (identity) this.reconcileIdentityPrivacy(identity.aliases.map((alias) => alias.jid));
    }
    const chat = this.ensureChat(chatJid, {
      identityId: chatIdentity?.id,
      lastMessageAt: timestamp,
    });
    const existing = this.state.db.prepare(
      "SELECT id FROM messages WHERE transport_chat_jid = ? AND source_id = ?",
    ).get(chatJid, parsed.sourceId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const tombstone = this.state.db.prepare(`
      SELECT deleted_at FROM message_tombstones
      WHERE transport_chat_jid = ? AND source_id = ?
    `).get(chatJid, parsed.sourceId) as { deleted_at: number } | undefined;
    const chatClear = this.state.db.prepare(`
      SELECT cleared_at FROM chat_clear_tombstones WHERE transport_chat_jid = ?
    `).get(chatJid) as { cleared_at: number } | undefined;
    const clearedByChat = Boolean(chatClear) && (
      sourceTimestampValid ? timestamp <= chatClear!.cleared_at : true
    );
    const deletionTime = tombstone?.deleted_at ?? (clearedByChat ? chatClear!.cleared_at : undefined);
    const hidden = deletionTime !== undefined || parsed.viewOnce;
    this.state.db.prepare(`
      INSERT INTO messages (
        id, chat_id, source_id, transport_chat_jid, participant_jid,
        sender_identity_id, sender_e164, from_me, timestamp, source_timestamp_valid, text,
        media_kind, media_mime, media_filename, media_size, quoted_source_id,
        edited_at, deleted_at, expires_at, view_once, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport_chat_jid, source_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        participant_jid = COALESCE(excluded.participant_jid, messages.participant_jid),
        sender_identity_id = COALESCE(excluded.sender_identity_id, messages.sender_identity_id),
        sender_e164 = COALESCE(excluded.sender_e164, messages.sender_e164),
        timestamp = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.timestamp ELSE excluded.timestamp END,
        source_timestamp_valid = CASE
          WHEN excluded.edited_at IS NOT NULL OR
            (messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL)
          THEN messages.source_timestamp_valid ELSE excluded.source_timestamp_valid END,
        text = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.text ELSE excluded.text END,
        media_kind = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.media_kind ELSE excluded.media_kind END,
        media_mime = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.media_mime ELSE excluded.media_mime END,
        media_filename = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.media_filename ELSE excluded.media_filename END,
        media_size = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.media_size ELSE excluded.media_size END,
        quoted_source_id = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.quoted_source_id ELSE excluded.quoted_source_id END,
        edited_at = COALESCE(excluded.edited_at, messages.edited_at),
        deleted_at = COALESCE(messages.deleted_at, excluded.deleted_at),
        expires_at = CASE
          WHEN messages.expires_at IS NULL THEN excluded.expires_at
          WHEN excluded.expires_at IS NULL THEN messages.expires_at
          ELSE MIN(messages.expires_at, excluded.expires_at)
        END,
        view_once = MAX(messages.view_once, excluded.view_once),
        raw_json = CASE
          WHEN messages.edited_at IS NOT NULL AND excluded.edited_at IS NULL
          THEN messages.raw_json ELSE excluded.raw_json END,
        updated_at = excluded.updated_at
    `).run(
      id,
      chat.id,
      parsed.sourceId,
      chatJid,
      parsed.participantJid ?? null,
      senderIdentity?.id ?? null,
      senderIdentity?.e164 ?? null,
      parsed.fromMe ? 1 : 0,
      timestamp,
      sourceTimestampValid ? 1 : 0,
      hidden ? null : parsed.text ?? null,
      hidden ? null : parsed.media?.kind ?? null,
      hidden ? null : parsed.media?.mime ?? null,
      hidden ? null : parsed.media?.filename ?? null,
      hidden ? null : parsed.media?.size ?? null,
      hidden ? null : parsed.quotedSourceId ?? null,
      edited ? now : null,
      deletionTime ?? null,
      parsed.expiresAt ?? null,
      parsed.viewOnce ? 1 : 0,
      hidden ? null : parsed.rawJson ?? null,
      now,
      now,
    );
    this.state.db.prepare(`
      UPDATE messages SET text = NULL, media_kind = NULL, media_mime = NULL,
        media_filename = NULL, media_size = NULL, quoted_source_id = NULL,
        raw_json = NULL
      WHERE id = ? AND (deleted_at IS NOT NULL OR view_once = 1)
    `).run(id);
    if (incrementUnread && !parsed.fromMe && !existing && !hidden) {
      this.state.db.prepare("UPDATE chats SET unread_count = unread_count + 1 WHERE id = ?").run(chat.id);
    }
  }

  private deletionKey(outerKey: WAMessageKey, embeddedKey?: WAMessageKey): WAMessageKey {
    const innerKey = embeddedKey ?? outerKey;
    const remoteJid = innerKey.remoteJid ?? outerKey.remoteJid;
    const innerAlternate = (innerKey as WAMessageKey & { remoteJidAlt?: unknown }).remoteJidAlt;
    const outerAlternate = (outerKey as WAMessageKey & { remoteJidAlt?: unknown }).remoteJidAlt;
    const alternate = isUserJid(remoteJid)
      ? [innerAlternate, outerAlternate, outerKey.remoteJid].find(
          (candidate) => isUserJid(candidate) && isLidJid(candidate) !== isLidJid(remoteJid),
        )
      : undefined;
    return {
      ...innerKey,
      remoteJid,
      remoteJidAlt: alternate,
    } as WAMessageKey;
  }

  private markDeleted(key: WAMessageKey, now = this.now()): void {
    if (!key.remoteJid || !isSafeMessageId(key.id) || !isSupportedChatJid(key.remoteJid)) return;
    const alternate = (key as WAMessageKey & { remoteJidAlt?: unknown }).remoteJidAlt;
    for (const chatJid of this.equivalentChatJids(key.remoteJid, alternate)) {
      this.state.db.prepare(`
        INSERT INTO message_tombstones (transport_chat_jid, source_id, deleted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(transport_chat_jid, source_id) DO UPDATE SET
          deleted_at = MAX(message_tombstones.deleted_at, excluded.deleted_at)
      `).run(chatJid, key.id, now);
      this.state.db.prepare(`
        UPDATE messages SET text = NULL, media_kind = NULL, media_mime = NULL,
          media_filename = NULL, media_size = NULL, quoted_source_id = NULL,
          raw_json = NULL, deleted_at = ?, updated_at = ?
        WHERE transport_chat_jid = ? AND source_id = ?
      `).run(now, now, chatJid, key.id);
    }
  }

  private recordChatClear(chatJid: string, now: number): void {
    this.state.db.prepare(`
      INSERT INTO chat_clear_tombstones (transport_chat_jid, cleared_at)
      VALUES (?, ?)
      ON CONFLICT(transport_chat_jid) DO UPDATE SET
        cleared_at = MAX(chat_clear_tombstones.cleared_at, excluded.cleared_at)
    `).run(chatJid, now);
    const clear = this.state.db.prepare(`
      SELECT cleared_at FROM chat_clear_tombstones WHERE transport_chat_jid = ?
    `).get(chatJid) as { cleared_at: number };
    this.state.db.prepare(`
      INSERT INTO message_tombstones (transport_chat_jid, source_id, deleted_at)
      SELECT transport_chat_jid, source_id, ? FROM messages WHERE transport_chat_jid = ?
      ON CONFLICT(transport_chat_jid, source_id) DO UPDATE SET
        deleted_at = MAX(message_tombstones.deleted_at, excluded.deleted_at)
    `).run(clear.cleared_at, chatJid);
    this.state.db.prepare(`
      UPDATE messages SET text = NULL, media_kind = NULL, media_mime = NULL,
        media_filename = NULL, media_size = NULL, quoted_source_id = NULL,
        raw_json = NULL, deleted_at = MAX(COALESCE(deleted_at, 0), ?),
        updated_at = MAX(updated_at, ?)
      WHERE transport_chat_jid = ?
    `).run(clear.cleared_at, clear.cleared_at, chatJid);
  }

  private equivalentChatJids(jid: string, alternate?: unknown): string[] {
    if (isGroupJid(jid)) return [normalizeChatJid(jid)];
    const result = new Set<string>();
    const add = (candidate: unknown) => {
      if (isUserJid(candidate)) result.add(normalizeChatJid(candidate));
    };
    add(jid);
    if (isUserJid(alternate) && isLidJid(jid) !== isLidJid(alternate)) add(alternate);
    for (const candidate of [...result]) {
      const identity = this.identities.findByJid(candidate);
      for (const alias of identity?.aliases ?? []) add(alias.jid);
    }
    return [...result];
  }

  private reconcileIdentityPrivacy(jids: string[]): void {
    const aliases = [...new Set(
      jids.filter(isUserJid).map((jid) => normalizeChatJid(jid)),
    )];
    if (aliases.length < 2) return;

    let clearCutoff = 0;
    const tombstones = new Map<string, number>();
    for (const jid of aliases) {
      const clear = this.state.db.prepare(
        "SELECT cleared_at FROM chat_clear_tombstones WHERE transport_chat_jid = ?",
      ).get(jid) as { cleared_at: number } | undefined;
      clearCutoff = Math.max(clearCutoff, clear?.cleared_at ?? 0);
      const rows = this.state.db.prepare(`
        SELECT source_id, deleted_at FROM message_tombstones
        WHERE transport_chat_jid = ?
      `).all(jid) as { source_id: string; deleted_at: number }[];
      for (const row of rows) {
        tombstones.set(
          row.source_id,
          Math.max(tombstones.get(row.source_id) ?? 0, row.deleted_at),
        );
      }
    }
    if (clearCutoff > 0) {
      for (const jid of aliases) {
        const clearedRows = this.state.db.prepare(`
          SELECT source_id FROM messages
          WHERE transport_chat_jid = ?
            AND (source_timestamp_valid = 0 OR timestamp <= ?)
        `).all(jid, clearCutoff) as { source_id: string }[];
        for (const row of clearedRows) {
          tombstones.set(
            row.source_id,
            Math.max(tombstones.get(row.source_id) ?? 0, clearCutoff),
          );
        }
      }
    }

    const upsertClear = this.state.db.prepare(`
      INSERT INTO chat_clear_tombstones (transport_chat_jid, cleared_at) VALUES (?, ?)
      ON CONFLICT(transport_chat_jid) DO UPDATE SET
        cleared_at = MAX(chat_clear_tombstones.cleared_at, excluded.cleared_at)
    `);
    const upsertTombstone = this.state.db.prepare(`
      INSERT INTO message_tombstones (transport_chat_jid, source_id, deleted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(transport_chat_jid, source_id) DO UPDATE SET
        deleted_at = MAX(message_tombstones.deleted_at, excluded.deleted_at)
    `);
    for (const jid of aliases) {
      if (clearCutoff > 0) {
        upsertClear.run(jid, clearCutoff);
        this.state.db.prepare(`
          UPDATE messages SET text = NULL, media_kind = NULL, media_mime = NULL,
            media_filename = NULL, media_size = NULL, quoted_source_id = NULL,
            raw_json = NULL, deleted_at = MAX(COALESCE(deleted_at, 0), ?),
            updated_at = MAX(updated_at, ?)
          WHERE transport_chat_jid = ?
            AND (source_timestamp_valid = 0 OR timestamp <= ?)
        `).run(clearCutoff, clearCutoff, jid, clearCutoff);
      }
      for (const [sourceId, deletedAt] of tombstones) {
        upsertTombstone.run(jid, sourceId, deletedAt);
        this.state.db.prepare(`
          UPDATE messages SET text = NULL, media_kind = NULL, media_mime = NULL,
            media_filename = NULL, media_size = NULL, quoted_source_id = NULL,
            raw_json = NULL, deleted_at = MAX(COALESCE(deleted_at, 0), ?),
            updated_at = MAX(updated_at, ?)
          WHERE transport_chat_jid = ? AND source_id = ?
        `).run(deletedAt, deletedAt, jid, sourceId);
      }
    }
  }

  private existingMessageLocations(
    key: WAMessageKey,
  ): { remoteJid: string | null | undefined; timestamp?: number }[] {
    if (!key.remoteJid || !isSafeMessageId(key.id) || !isSupportedChatJid(key.remoteJid)) {
      return [];
    }
    const alternate = (key as WAMessageKey & { remoteJidAlt?: unknown }).remoteJidAlt;
    const statement = this.state.db.prepare(
      "SELECT timestamp FROM messages WHERE transport_chat_jid = ? AND source_id = ?",
    );
    const result: { remoteJid: string; timestamp: number }[] = [];
    for (const remoteJid of this.equivalentChatJids(key.remoteJid, alternate)) {
      const row = statement.get(remoteJid, key.id) as { timestamp: number } | undefined;
      if (row) result.push({ remoteJid, timestamp: row.timestamp });
    }
    return result;
  }

  private ensureChat(jid: string, update: {
    title?: string;
    unreadCount?: number;
    lastMessageAt?: number;
    identityId?: string;
  } = {}): { id: string } {
    const transportJid = normalizeChatJid(jid);
    const existing = this.state.db.prepare("SELECT id FROM chats WHERE transport_jid = ?").get(transportJid) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const directIdentity = !isGroupJid(transportJid)
      ? update.identityId ?? this.identities.observe({ jid: transportJid }).id
      : undefined;
    this.state.db.prepare(`
      INSERT INTO chats (
        id, transport_jid, kind, identity_id, title, unread_count,
        last_message_at, updated_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(transport_jid) DO UPDATE SET
        identity_id = COALESCE(excluded.identity_id, chats.identity_id),
        title = COALESCE(excluded.title, chats.title),
        unread_count = CASE WHEN ? IS NULL THEN chats.unread_count ELSE excluded.unread_count END,
        last_message_at = MAX(COALESCE(chats.last_message_at, 0), COALESCE(excluded.last_message_at, 0)),
        updated_at = excluded.updated_at,
        raw_json = NULL
    `).run(
      id,
      transportJid,
      isGroupJid(transportJid) ? "group" : "direct",
      directIdentity ?? null,
      cleanTitle(update.title),
      Math.max(0, update.unreadCount ?? 0),
      update.lastMessageAt ?? null,
      this.now(),
      update.unreadCount ?? null,
    );
    return { id };
  }

  private requireChat(id: string): void {
    if (!this.resolveChat(id)) throw new SafeWhatsAppError("WhatsApp chat was not found.", "chat_not_found");
  }
}
