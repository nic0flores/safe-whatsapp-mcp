// Agent context note: Resolves the current oldest safe chat-local anchor and retention outcomes for bounded on-demand history requests. Tests: test/core-history-anchor.test.mjs. Keep transport identifiers internal and never accept stale/newer cursors or bypass MessageStore retention, deletion, expiry, or view-once rules.
import type { WAMessageKey } from "baileys";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import type { SqliteState } from "../storage/database.js";
import { isSafeMessageId, isSupportedChatJid } from "./messageStoreHelpers.js";

const MAX_HISTORY_BATCH = 50;

interface AnchorRow {
  id: string;
  source_id: string;
  transport_chat_jid: string;
  from_me: number;
  timestamp: number;
}

export interface HistoryRetentionState {
  retentionDays: number;
  maxMessagesPerChat: number;
  cachedMessageCount: number;
  capacityRemaining: number;
  cutoffAt: string;
  canRetainOlder: boolean;
}

export interface HistoryAnchor {
  messageId: string;
  key: WAMessageKey;
  timestampMs: number;
  retention: HistoryRetentionState;
}

export interface HistoryResponseRetention {
  retainedCount: number;
  newlyRetainedCount: number;
  nextBeforeMessageId?: string;
  oldestRetainedAt?: string;
  retention: HistoryRetentionState;
}

export class HistoryAnchorStore {
  constructor(
    private readonly state: SqliteState,
    private readonly config: Pick<SafeWhatsAppConfig, "retentionMs" | "maxMessagesPerChat">,
    private readonly now: () => number = Date.now,
  ) {}

  resolve(input: { chatId: string; beforeMessageId?: string }): HistoryAnchor {
    this.requireChat(input.chatId);
    const now = this.now();
    const cutoff = now - this.config.retentionMs;
    const oldest = this.oldestEligible(input.chatId, now, cutoff);
    if (!oldest) throw anchorUnavailable();
    const row = input.beforeMessageId
      ? this.eligibleById(input.chatId, input.beforeMessageId, now, cutoff)
      : oldest;
    if (!row) throw anchorUnavailable();
    if (row.id !== oldest.id) {
      throw new SafeWhatsAppError(
        "beforeMessageId must identify the current oldest retained message for this chat.",
        "history_anchor_not_oldest",
      );
    }
    this.validateAnchor(row, now);
    return {
      messageId: row.id,
      key: {
        remoteJid: row.transport_chat_jid,
        id: row.source_id,
        fromMe: Boolean(row.from_me),
      },
      timestampMs: row.timestamp,
      retention: this.retentionState(input.chatId, row.timestamp, now, cutoff),
    };
  }

  retainedSourceIds(chatId: string): ReadonlySet<string> {
    this.requireChat(chatId);
    const now = this.now();
    const cutoff = now - this.config.retentionMs;
    const rows = this.state.db.prepare(`
      SELECT source_id FROM messages
      WHERE chat_id = ? AND source_timestamp_valid = 1
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
        AND timestamp >= ? AND created_at >= ?
    `).all(chatId, now, cutoff, cutoff) as { source_id: string }[];
    return new Set(rows.map((row) => row.source_id).filter(isSafeMessageId));
  }

  summarizeResponse(
    chatId: string,
    sourceIds: readonly string[],
    previouslyRetainedSourceIds: ReadonlySet<string>,
  ): HistoryResponseRetention {
    this.requireChat(chatId);
    if (sourceIds.length > MAX_HISTORY_BATCH) {
      throw new SafeWhatsAppError(
        "WhatsApp returned an invalid history batch.",
        "history_response_invalid",
      );
    }
    const now = this.now();
    const cutoff = now - this.config.retentionMs;
    const retained = this.state.db.prepare(`
      SELECT 1 FROM messages
      WHERE chat_id = ? AND source_id = ? AND source_timestamp_valid = 1
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
        AND timestamp >= ? AND created_at >= ?
      LIMIT 1
    `);
    let retainedCount = 0;
    let newlyRetainedCount = 0;
    for (const sourceId of new Set(sourceIds.filter(isSafeMessageId))) {
      if (!retained.get(chatId, sourceId, now, cutoff, cutoff)) continue;
      retainedCount += 1;
      if (!previouslyRetainedSourceIds.has(sourceId)) newlyRetainedCount += 1;
    }
    const oldest = this.oldestEligible(chatId, now, cutoff);
    return {
      retainedCount,
      newlyRetainedCount,
      ...(oldest ? {
        nextBeforeMessageId: oldest.id,
        oldestRetainedAt: new Date(oldest.timestamp).toISOString(),
      } : {}),
      retention: this.retentionState(chatId, oldest?.timestamp, now, cutoff),
    };
  }

  private oldestEligible(chatId: string, now: number, cutoff: number): AnchorRow | undefined {
    return this.state.db.prepare(`
      SELECT id, source_id, transport_chat_jid, from_me, timestamp
      FROM messages
      WHERE chat_id = ? AND source_timestamp_valid = 1
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
        AND timestamp >= ? AND created_at >= ?
      ORDER BY timestamp ASC, id ASC
      LIMIT 1
    `).get(chatId, now, cutoff, cutoff) as AnchorRow | undefined;
  }

  private eligibleById(
    chatId: string,
    messageId: string,
    now: number,
    cutoff: number,
  ): AnchorRow | undefined {
    return this.state.db.prepare(`
      SELECT id, source_id, transport_chat_jid, from_me, timestamp
      FROM messages
      WHERE id = ? AND chat_id = ? AND source_timestamp_valid = 1
        AND deleted_at IS NULL AND view_once = 0
        AND (expires_at IS NULL OR expires_at > ?)
        AND timestamp >= ? AND created_at >= ?
      LIMIT 1
    `).get(messageId, chatId, now, cutoff, cutoff) as AnchorRow | undefined;
  }

  private retentionState(
    chatId: string,
    anchorTimestamp: number | undefined,
    now: number,
    cutoff: number,
  ): HistoryRetentionState {
    const row = this.state.db.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE chat_id = ? AND timestamp >= ? AND created_at >= ?
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(chatId, cutoff, cutoff, now) as { count: number };
    const cachedMessageCount = row.count;
    const capacityRemaining = Math.max(0, this.config.maxMessagesPerChat - cachedMessageCount);
    return {
      retentionDays: this.config.retentionMs / 86_400_000,
      maxMessagesPerChat: this.config.maxMessagesPerChat,
      cachedMessageCount,
      capacityRemaining,
      cutoffAt: new Date(cutoff).toISOString(),
      canRetainOlder: anchorTimestamp !== undefined &&
        anchorTimestamp > cutoff && capacityRemaining > 0,
    };
  }

  private requireChat(chatId: string): void {
    const row = this.state.db.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId);
    if (!row) throw new SafeWhatsAppError("WhatsApp chat was not found.", "chat_not_found");
  }

  private validateAnchor(row: AnchorRow, now: number): void {
    if (!isSupportedChatJid(row.transport_chat_jid) || !isSafeMessageId(row.source_id) ||
        ![0, 1].includes(row.from_me) || !Number.isSafeInteger(row.timestamp) ||
        row.timestamp <= 0 || row.timestamp > now + 300_000) {
      throw new SafeWhatsAppError(
        "The retained history anchor is invalid.",
        "history_anchor_invalid",
      );
    }
  }
}

function anchorUnavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "No retained message can anchor an older-history request for this chat.",
    "history_anchor_unavailable",
  );
}
