// Agent context note: Sends one bounded, request-correlated Baileys on-demand history request. Tests: test/on-demand-history.test.mjs. Keep this single-batch, max-50, timeout-to-pending, and never add automatic retries or bulk-history loops; update this note after meaningful changes.
import { proto, type WAMessage, type WAMessageKey } from "baileys";
import { SafeWhatsAppError } from "../errors.js";
import type { WhatsAppSocket } from "./socketTypes.js";

export const MAX_ON_DEMAND_HISTORY_MESSAGES = 50;
export const DEFAULT_ON_DEMAND_HISTORY_TIMEOUT_MS = 30_000;

export interface OnDemandHistoryRequest {
  oldestMessageKey: WAMessageKey;
  oldestMessageTimestampMs: number;
  count?: number;
  timeoutMs?: number;
}

export type OnDemandHistoryResult =
  | { status: "received"; requestId: string; messages: WAMessage[] }
  | { status: "pending"; requestId?: string };

interface HistorySet {
  messages: WAMessage[];
  syncType?: proto.HistorySync.HistorySyncType | null;
  peerDataRequestSessionId?: string | null;
}

export async function fetchOnDemandHistory(
  socket: WhatsAppSocket,
  input: OnDemandHistoryRequest,
): Promise<OnDemandHistoryResult> {
  const count = input.count ?? MAX_ON_DEMAND_HISTORY_MESSAGES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_ON_DEMAND_HISTORY_TIMEOUT_MS;
  validateRequest(input.oldestMessageKey, input.oldestMessageTimestampMs, count, timeoutMs);

  let requestId: string | undefined;
  let matchingHistory: HistorySet | undefined;
  let resolveMatch!: () => void;
  const matched = new Promise<void>((resolve) => { resolveMatch = resolve; });
  const earlyHistory: HistorySet[] = [];
  const listener = ((history: HistorySet) => {
    if (
      history.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND ||
      !history.peerDataRequestSessionId
    ) return;
    if (!requestId) {
      earlyHistory.push(history);
      return;
    }
    if (history.peerDataRequestSessionId === requestId) {
      matchingHistory = history;
      resolveMatch();
    }
  }) as (value: never) => void;
  socket.events.on("messaging-history.set", listener);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const sent = socket.fetchMessageHistory(
      count,
      input.oldestMessageKey,
      input.oldestMessageTimestampMs,
    );
    const sendResult = await Promise.race([
      sent.then((id) => ({ status: "sent" as const, id })),
      timedOut.then(() => ({ status: "timeout" as const })),
    ]);
    if (sendResult.status === "timeout") return { status: "pending" };

    requestId = sendResult.id;
    matchingHistory = earlyHistory.find(
      (history) => history.peerDataRequestSessionId === requestId,
    );
    if (matchingHistory) resolveMatch();

    const response = await Promise.race([
      matched.then(() => "received" as const),
      timedOut,
    ]);
    return response === "received" && matchingHistory
      ? { status: "received", requestId, messages: matchingHistory.messages }
      : { status: "pending", requestId };
  } finally {
    if (timer) clearTimeout(timer);
    socket.events.off("messaging-history.set", listener);
  }
}

function validateRequest(
  key: WAMessageKey,
  timestampMs: number,
  count: number,
  timeoutMs: number,
): void {
  if (
    typeof key.remoteJid !== "string" || !key.remoteJid ||
    typeof key.id !== "string" || !key.id ||
    typeof key.fromMe !== "boolean"
  ) {
    throw new SafeWhatsAppError(
      "An intact oldest WhatsApp message is required to fetch earlier history.",
      "history_anchor_unavailable",
    );
  }
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new SafeWhatsAppError(
      "The oldest WhatsApp message timestamp must be provided in milliseconds.",
      "invalid_history_request",
    );
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ON_DEMAND_HISTORY_MESSAGES) {
    throw new SafeWhatsAppError(
      `History count must be an integer from 1 through ${MAX_ON_DEMAND_HISTORY_MESSAGES}.`,
      "invalid_history_request",
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new SafeWhatsAppError(
      "History request timeout must be an integer from 1 through 60000 milliseconds.",
      "invalid_history_request",
    );
  }
}
