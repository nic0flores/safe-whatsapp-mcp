// Agent context note: Coordinates one explicit, retention-bounded older-history batch through an active session. Tests: test/history-fetcher.test.mjs. Keep transport IDs private, preserve one global in-flight request, and never add retries, automatic paging, or retention bypasses.
import type { SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import {
  HistoryAnchorStore,
  type HistoryRetentionState,
} from "../messages/historyAnchorStore.js";
import type { MessageStore } from "../messages/messageStore.js";
import type { SqliteState } from "../storage/database.js";
import {
  DEFAULT_ON_DEMAND_HISTORY_TIMEOUT_MS,
  fetchOnDemandHistory,
  MAX_ON_DEMAND_HISTORY_MESSAGES,
} from "./onDemandHistory.js";
import type { SessionManager, SyncCompleteness } from "./sessionManager.js";

export interface FetchOlderMessagesInput {
  chatId: string;
  limit: number;
  beforeMessageId?: string;
}

export type FetchOlderMessagesResult = {
  chatId: string;
  requestedCount: number;
  syncCompleteness: SyncCompleteness;
  retention: HistoryRetentionState;
  nextBeforeMessageId?: string;
  oldestRetainedAt?: string;
} & (
  | { outcome: "retention_limited"; blockedBy: ("retention_window" | "message_cap")[] }
  | { outcome: "pending"; lateResponseMayStillSync: true }
  | {
      outcome: "received";
      receivedCount: number;
      retainedCount: number;
      newlyRetainedCount: number;
      anchorAdvanced: boolean;
    }
);

export class WhatsAppHistoryFetcher {
  private readonly anchors: HistoryAnchorStore;
  private readonly timeoutMs: number;
  private inFlight = false;

  constructor(
    state: SqliteState,
    private readonly messages: MessageStore,
    private readonly sessions: SessionManager,
    private readonly config: Pick<SafeWhatsAppConfig, "retentionMs" | "maxMessagesPerChat" | "syncTimeoutMs">,
    options: { timeoutMs?: number } = {},
  ) {
    this.anchors = new HistoryAnchorStore(state, config);
    this.timeoutMs = options.timeoutMs ?? Math.min(
      config.syncTimeoutMs,
      DEFAULT_ON_DEMAND_HISTORY_TIMEOUT_MS,
    );
  }

  async fetch(input: FetchOlderMessagesInput): Promise<FetchOlderMessagesResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 ||
        input.limit > MAX_ON_DEMAND_HISTORY_MESSAGES) {
      throw new SafeWhatsAppError(
        `History count must be an integer from 1 through ${MAX_ON_DEMAND_HISTORY_MESSAGES}.`,
        "invalid_history_request",
      );
    }
    if (this.inFlight) {
      throw new SafeWhatsAppError(
        "Another older-history request is already in progress.",
        "history_fetch_in_progress",
      );
    }
    this.inFlight = true;
    try {
      const session = await this.sessions.run(async (socket) => {
        this.messages.prune();
        const anchor = this.anchors.resolve(input);
        const base = {
          chatId: input.chatId,
          requestedCount: input.limit,
          retention: anchor.retention,
          nextBeforeMessageId: anchor.messageId,
          oldestRetainedAt: new Date(anchor.timestampMs).toISOString(),
        };
        if (!anchor.retention.canRetainOlder) {
          const cutoff = Date.parse(anchor.retention.cutoffAt);
          return {
            ...base,
            outcome: "retention_limited" as const,
            blockedBy: [
              ...(anchor.timestampMs <= cutoff ? ["retention_window" as const] : []),
              ...(anchor.retention.capacityRemaining === 0 ? ["message_cap" as const] : []),
            ],
          };
        }

        const previouslyRetainedSourceIds = this.anchors.retainedSourceIds(input.chatId);
        const fetched = await fetchOnDemandHistory(socket, {
          oldestMessageKey: anchor.key,
          oldestMessageTimestampMs: anchor.timestampMs,
          count: input.limit,
          timeoutMs: this.timeoutMs,
        });
        if (fetched.status === "pending") {
          return {
            ...base,
            outcome: "pending" as const,
            lateResponseMayStillSync: true as const,
          };
        }

        const summary = this.anchors.summarizeResponse(
          input.chatId,
          fetched.messages.flatMap((message) =>
            typeof message.key.id === "string" ? [message.key.id] : []),
          previouslyRetainedSourceIds,
        );
        return {
          ...base,
          outcome: "received" as const,
          receivedCount: fetched.messages.length,
          retainedCount: summary.retainedCount,
          newlyRetainedCount: summary.newlyRetainedCount,
          anchorAdvanced: Boolean(
            summary.nextBeforeMessageId && summary.nextBeforeMessageId !== anchor.messageId,
          ),
          retention: summary.retention,
          ...(summary.nextBeforeMessageId
            ? { nextBeforeMessageId: summary.nextBeforeMessageId }
            : {}),
          ...(summary.oldestRetainedAt
            ? { oldestRetainedAt: summary.oldestRetainedAt }
            : {}),
        };
      });
      return { ...session.value, syncCompleteness: session.syncCompleteness };
    } finally {
      this.inFlight = false;
    }
  }
}
