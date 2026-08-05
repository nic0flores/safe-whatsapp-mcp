// Agent context note: Converts a known WhatsApp acknowledgement into a local terminal record without letting local persistence relabel delivery. Tests: test/send-service.test.mjs. Server acceptance/rejection/uncertainty stays authoritative even when the send ledger cannot be updated; update this note after meaningful changes.
import type { PendingSendRepository } from "./pendingStore.js";
import type { OutboundSendResult, PendingSendRecord } from "./types.js";

export interface CompletedTransportOutcome {
  record: PendingSendRecord;
  state: "sent" | "failed" | "uncertain";
  errorCode?: string;
}

export async function completeTransportOutcome(
  store: PendingSendRepository,
  claimed: PendingSendRecord,
  result: OutboundSendResult,
  now: Date,
): Promise<CompletedTransportOutcome> {
  const requestedState = result.outcome === "accepted" ? "sent" :
    result.outcome === "rejected" ? "failed" : "uncertain";
  const requestedError = result.outcome === "rejected"
    ? result.errorCode
    : result.outcome === "uncertain" ? "transport_outcome_unknown" : undefined;
  let record = claimed;
  try {
    record = await store.finish(claimed.id, requestedState, now, {
      transportMessageId: result.messageId,
      ...(requestedError ? { errorCode: requestedError } : {}),
    });
  } catch { /* Preserve the already-known transport outcome for the user. */ }
  return record.state === "failed"
    ? { record, state: "failed", ...(record.errorCode ? { errorCode: record.errorCode } : {}) }
    : { record, state: requestedState, ...(requestedError ? { errorCode: requestedError } : {}) };
}
