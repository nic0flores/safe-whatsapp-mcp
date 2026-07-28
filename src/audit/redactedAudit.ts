// Agent context note: Writes a symlink-safe redacted 30-day audit trail and removes only recognized stale audit temps. Tests: test/send-service.test.mjs. Never add recipient identifiers, names, filenames, message text, QR data, or auth material; update this note after meaningful behavior changes.
import { constants as fsConstants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";

export type AuditAction = "prepare" | "send" | "discard" | "expire" | "recover";
export type AuditResult = "prepared" | "sent" | "discarded" | "expired" | "failed" | "uncertain" | "refused";

export interface RedactedAuditEvent {
  action: AuditAction;
  result: AuditResult;
  pendingId: string;
  digest?: string;
  messageKind: "text" | "media";
  destinationKind: "direct" | "group";
  errorCode?: string;
}

export interface SendAuditSink {
  record(event: RedactedAuditEvent): Promise<void>;
  prune(before: Date): Promise<void>;
}

export class JsonLineAuditLogger implements SendAuditSink {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly retentionMs = 30 * 86_400_000,
  ) {}

  async record(event: RedactedAuditEvent): Promise<void> {
    await this.exclusive(async () => {
      const now = this.now();
      await this.pruneUnlocked(new Date(now.getTime() - this.retentionMs));
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({ timestamp: now.toISOString(), ...event })}\n`;
      await appendAuditLine(this.filePath, line);
    });
  }

  async prune(before: Date): Promise<void> {
    await this.exclusive(() => this.pruneUnlocked(before));
  }

  private async pruneUnlocked(before: Date): Promise<void> {
    await removeStaleAuditTemps(this.filePath, this.now());
    let raw: string;
    try {
      raw = (await readAuditFile(this.filePath)).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const kept = raw.split("\n").filter((line) => {
      if (!line) return false;
      try {
        const timestamp = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        return typeof timestamp === "string" && Date.parse(timestamp) >= before.getTime();
      } catch {
        return false;
      }
    });
    const next = kept.length ? `${kept.join("\n")}\n` : "";
    if (next === raw) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, next, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

export class NullAuditLogger implements SendAuditSink {
  async record(_event: RedactedAuditEvent): Promise<void> {}
  async prune(_before: Date): Promise<void> {}
}

async function appendAuditLine(filePath: string, line: string): Promise<void> {
  await assertSafeExistingAuditFile(filePath);
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!(await handle.stat()).isFile()) throw unsafeAuditFile();
    await handle.writeFile(line, "utf8");
    await handle.chmod(0o600).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw unsafeAuditFile();
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readAuditFile(filePath: string): Promise<Buffer> {
  await assertSafeExistingAuditFile(filePath);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) throw unsafeAuditFile();
    return await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw unsafeAuditFile();
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertSafeExistingAuditFile(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw unsafeAuditFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function unsafeAuditFile(): SafeWhatsAppError {
  return new SafeWhatsAppError("The audit file path is unsafe.", "unsafe_audit_file");
}

async function removeStaleAuditTemps(
  auditFile: string,
  now: Date,
  graceMs = 5 * 60_000,
): Promise<void> {
  const directory = path.dirname(auditFile);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const escaped = path.basename(auditFile).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${escaped}\\.\\d+\\.([0-9a-f-]{36})\\.tmp$`, "iu");
  for (const entry of entries) {
    const match = pattern.exec(entry.name);
    if (!match || !isUuid(match[1])) continue;
    const candidate = path.join(directory, entry.name);
    const stat = await fs.lstat(candidate);
    if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.mtimeMs > now.getTime() - graceMs) continue;
    await fs.unlink(candidate);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
