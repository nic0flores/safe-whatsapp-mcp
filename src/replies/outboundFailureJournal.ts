// Agent context note: Durably journals sanitized exact-ID WhatsApp rejections before asynchronous send-ledger reconciliation. Tests: test/message-resync.test.mjs and test/core-event-router.test.mjs. Keep entries content-free, bounded, and removable only after correlation or retention expiry; update this note after meaningful changes.
import { createHash } from "node:crypto";
import type { SqliteState } from "../storage/database.js";

const PREFIX = "outbound_rejection:";
const MAX_ENTRIES = 512;

export interface JournaledOutboundFailure {
  messageId: string;
  errorCode: string;
  receivedAt: string;
}

export class OutboundFailureJournal {
  constructor(private readonly state: SqliteState) {}

  record(messageId: string, errorCode: string, now = new Date()): void {
    assertFailure(messageId, errorCode);
    const value = JSON.stringify({ messageId, errorCode, receivedAt: now.toISOString() });
    this.state.db.prepare(`
      INSERT INTO local_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(keyFor(messageId), value);
    const overflow = this.list()
      .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
      .slice(0, -MAX_ENTRIES);
    for (const failure of overflow) this.remove(failure.messageId);
  }

  list(): JournaledOutboundFailure[] {
    const rows = this.state.db.prepare(
      "SELECT value FROM local_meta WHERE key LIKE ? ORDER BY key",
    ).all(`${PREFIX}%`) as { value: string }[];
    return rows.map(({ value }) => parsedFailure(value));
  }

  remove(messageId: string): void {
    this.state.db.prepare("DELETE FROM local_meta WHERE key = ?").run(keyFor(messageId));
  }

  prune(before: Date): void {
    for (const failure of this.list()) {
      if (Date.parse(failure.receivedAt) < before.getTime()) this.remove(failure.messageId);
    }
  }
}

function keyFor(messageId: string): string {
  return PREFIX + createHash("sha256").update(messageId).digest("hex");
}

function parsedFailure(value: string): JournaledOutboundFailure {
  const parsed = JSON.parse(value) as Partial<JournaledOutboundFailure>;
  assertFailure(parsed.messageId, parsed.errorCode);
  if (typeof parsed.receivedAt !== "string" || !Number.isFinite(Date.parse(parsed.receivedAt))) {
    throw new Error("Invalid outbound rejection journal entry.");
  }
  return parsed as JournaledOutboundFailure;
}

function assertFailure(messageId: unknown, errorCode: unknown): asserts messageId is string {
  if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 512 ||
      typeof errorCode !== "string" || !/^whatsapp_rejected(?:_\d{1,6})?$/u.test(errorCode)) {
    throw new Error("Invalid outbound rejection journal entry.");
  }
}
