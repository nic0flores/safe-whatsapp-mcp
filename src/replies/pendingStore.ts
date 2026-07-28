// Agent context note: Strictly validates and durably persists staged-send records, serializes transitions, and prunes stale draft temps. Tests: test/send-service.test.mjs. Only integrity-checked, no-follow prepared records may atomically become sending; update this note after meaningful behavior changes.
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import { ensurePrivateDir } from "../storage/privateFiles.js";
import type { PendingSendRecord, PendingSendState } from "./types.js";
import { assertPayloadIntegrity, validatePendingSendRecord } from "./recordValidation.js";

export interface PendingSendRepository {
  create(record: PendingSendRecord): Promise<void>;
  get(id: string): Promise<PendingSendRecord | undefined>;
  list(): Promise<PendingSendRecord[]>;
  claim(id: string, digest: string, approvalPreview: string, now: Date): Promise<PendingSendRecord>;
  finish(id: string, state: "sent" | "failed" | "uncertain", now: Date, details?: { transportMessageId?: string; errorCode?: string }): Promise<PendingSendRecord>;
  discard(id: string, now: Date): Promise<PendingSendRecord | undefined>;
  expirePrepared(now: Date): Promise<PendingSendRecord[]>;
  recoverSending(now: Date): Promise<PendingSendRecord[]>;
  pruneTerminal(before: Date): Promise<void>;
  removeStaleTempArtifacts(now: Date, graceMs?: number): Promise<number>;
}

export class FilePendingSendStore implements PendingSendRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async create(record: PendingSendRecord): Promise<void> {
    await this.exclusive(async () => {
      await this.ensureDirectory();
      assertPendingId(record.id);
      validatePendingSendRecord(record, record.id, this.directory);
      const filePath = this.fileFor(record.id);
      try {
        await fs.access(filePath);
        throw new SafeWhatsAppError("Pending send already exists.", "pending_send_exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.write(record);
    });
  }

  async get(id: string): Promise<PendingSendRecord | undefined> {
    assertPendingId(id);
    return this.read(id);
  }

  async list(): Promise<PendingSendRecord[]> {
    await this.ensureDirectory();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records: PendingSendRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!isPendingId(id)) continue;
      const record = await this.read(id);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async claim(id: string, digest: string, approvalPreview: string, now: Date): Promise<PendingSendRecord> {
    return this.exclusive(async () => {
      const record = await this.require(id);
      if (record.state !== "prepared") throw stateError(record.state);
      if (!record.payload || !record.approvalPreview) throw corruptRecordError();
      if (Date.parse(record.expiresAt) <= now.getTime()) {
        throw new SafeWhatsAppError("The prepared send has expired.", "pending_send_expired");
      }
      if (record.digest !== digest) {
        throw new SafeWhatsAppError("Digest mismatch. Refusing to send.", "digest_mismatch");
      }
      if (record.approvalPreview !== approvalPreview) {
        throw new SafeWhatsAppError("Approval preview mismatch. Refusing to send.", "approval_mismatch");
      }
      assertPayloadIntegrity(record.payload, record.approvalPreview, record.digest, record.id);
      const claimed = updateState(record, "sending", now);
      await this.write(claimed);
      return claimed;
    });
  }

  async finish(
    id: string,
    state: "sent" | "failed" | "uncertain",
    now: Date,
    details: { transportMessageId?: string; errorCode?: string } = {},
  ): Promise<PendingSendRecord> {
    return this.exclusive(async () => {
      const record = await this.require(id);
      if (record.state !== "sending") throw stateError(record.state);
      if (!record.payload) throw corruptRecordError();
      const finished = { ...updateState(record, state, now), ...details };
      await this.write({ ...finished, payload: null, approvalPreview: null });
      return finished;
    });
  }

  async discard(id: string, now: Date): Promise<PendingSendRecord | undefined> {
    return this.exclusive(async () => {
      const record = await this.read(id);
      if (!record) return undefined;
      if (record.state !== "prepared") throw stateError(record.state);
      if (!record.payload) throw corruptRecordError();
      const discarded = updateState(record, "discarded", now);
      await this.write({ ...discarded, payload: null, approvalPreview: null });
      return discarded;
    });
  }

  async expirePrepared(now: Date): Promise<PendingSendRecord[]> {
    return this.exclusive(async () => {
      const records = await this.list();
      const expired: PendingSendRecord[] = [];
      for (const record of records) {
        if (record.state !== "prepared" || Date.parse(record.expiresAt) > now.getTime()) continue;
        if (!record.payload) throw corruptRecordError();
        const next = updateState(record, "expired", now);
        await this.write({ ...next, payload: null, approvalPreview: null });
        expired.push(next);
      }
      return expired;
    });
  }

  async recoverSending(now: Date): Promise<PendingSendRecord[]> {
    return this.exclusive(async () => {
      const records = await this.list();
      const recovered: PendingSendRecord[] = [];
      for (const record of records) {
        if (record.state !== "sending") continue;
        if (!record.payload) throw corruptRecordError();
        const next = {
          ...updateState(record, "uncertain", now),
          errorCode: "interrupted_send",
        };
        await this.write({ ...next, payload: null, approvalPreview: null });
        recovered.push(next);
      }
      return recovered;
    });
  }

  async pruneTerminal(before: Date): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.list();
      for (const record of records) {
        if (record.state === "prepared" || record.state === "sending") continue;
        if (Date.parse(record.updatedAt) >= before.getTime()) continue;
        await fs.unlink(this.fileFor(record.id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    });
  }

  async removeStaleTempArtifacts(now: Date, graceMs = 5 * 60_000): Promise<number> {
    return this.exclusive(async () => {
      await this.ensureDirectory();
      const pattern = /^([0-9a-f-]{36})\.json\.\d+\.([0-9a-f-]{36})\.tmp$/iu;
      let removed = 0;
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        const match = pattern.exec(entry.name);
        if (!match || !isPendingId(match[1]) || !isPendingId(match[2])) continue;
        const candidate = path.join(this.directory, entry.name);
        const stat = await fs.lstat(candidate);
        if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.mtimeMs > now.getTime() - graceMs) continue;
        await fs.unlink(candidate);
        removed += 1;
      }
      return removed;
    });
  }

  private async require(id: string): Promise<PendingSendRecord> {
    const record = await this.read(id);
    if (!record) throw new SafeWhatsAppError("Prepared send was not found.", "pending_send_not_found");
    return record;
  }

  private async read(id: string): Promise<PendingSendRecord | undefined> {
    assertPendingId(id);
    let raw: string;
    let handle;
    try {
      handle = await fs.open(
        this.fileFor(id),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      if (!(await handle.stat()).isFile()) throw corruptRecordError();
      raw = await handle.readFile("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw corruptRecordError();
      throw error;
    } finally {
      await handle?.close();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return validatePendingSendRecord(undefined, id, this.directory);
    }
    return validatePendingSendRecord(parsed, id, this.directory);
  }

  private async write(record: PendingSendRecord): Promise<void> {
    await this.ensureDirectory();
    validatePendingSendRecord(record, record.id, this.directory);
    const target = this.fileFor(record.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => undefined);
      await syncDirectory(this.directory);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async ensureDirectory(): Promise<void> {
    await ensurePrivateDir(this.directory);
  }

  private fileFor(id: string): string {
    assertPendingId(id);
    return path.join(this.directory, `${id}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function updateState(record: PendingSendRecord, state: PendingSendState, now: Date): PendingSendRecord {
  return { ...record, state, updatedAt: now.toISOString() };
}

function stateError(state: PendingSendState): SafeWhatsAppError {
  return new SafeWhatsAppError(
    `Prepared send cannot be used because its state is '${state}'.`,
    "pending_send_not_prepared",
  );
}

function corruptRecordError(): SafeWhatsAppError {
  return new SafeWhatsAppError("The prepared send record is incomplete.", "pending_send_corrupt");
}

function assertPendingId(id: string): void {
  if (!isPendingId(id)) throw new SafeWhatsAppError("Invalid pending send ID.", "invalid_pending_id");
}

function isPendingId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
