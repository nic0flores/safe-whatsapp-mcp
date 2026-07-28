// Agent context note: Enforces one writer process with crash-recoverable reclaim guards. Tests: test/core-process-lock.test.mjs. Reclaim only after the recorded PID is demonstrably absent.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import { ensurePrivateDir, isNodeError } from "./privateFiles.js";

interface LockRecord { pid: number; token: string; createdAt: string }
interface ReclaimGuard { path: string; token: string }

export class ProcessLock {
  private handle?: FileHandle;
  private token?: string;

  constructor(private readonly filePath: string) {}

  async acquire(): Promise<void> {
    if (this.handle) return;
    await ensurePrivateDir(path.dirname(this.filePath));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await this.create();
        return;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      const record = await this.readRecord();
      if (record && isRunning(record.pid)) throw lockedError();
      const reclaimed = await this.reclaimStale(record?.token);
      if (reclaimed) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw lockedError();
  }

  async release(): Promise<void> {
    const handle = this.handle;
    const token = this.token;
    this.handle = undefined;
    this.token = undefined;
    await handle?.close();
    if (!token) return;
    const current = await this.readRecord();
    if (current?.token === token) {
      await fs.unlink(this.filePath).catch((error) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async create(): Promise<void> {
    const token = randomUUID();
    const candidate = `${this.filePath}.candidate.${token}`;
    const candidateHandle = await fs.open(candidate, "wx", 0o600);
    let linked = false;
    try {
      const record: LockRecord = { pid: process.pid, token, createdAt: new Date().toISOString() };
      await candidateHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await candidateHandle.sync();
      await candidateHandle.close();
      await fs.link(candidate, this.filePath);
      linked = true;
      const handle = await fs.open(this.filePath, "r");
      this.handle = handle;
      this.token = token;
    } catch (error) {
      await candidateHandle.close().catch(() => undefined);
      if (linked) await fs.unlink(this.filePath).catch(() => undefined);
      throw error;
    } finally {
      await fs.unlink(candidate).catch(() => undefined);
    }
  }

  private async reclaimStale(expectedToken: string | undefined): Promise<boolean> {
    const guard = await this.acquireReclaimGuard();
    if (!guard) return false;
    const quarantine = `${this.filePath}.stale.${randomUUID()}`;
    try {
      const current = await this.readRecord();
      if (current?.token !== expectedToken || (current && isRunning(current.pid))) return false;
      try {
        await fs.rename(this.filePath, quarantine);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
      try {
        await this.create();
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") return false;
        throw error;
      } finally {
        await fs.unlink(quarantine).catch(() => undefined);
      }
    } finally {
      await this.releaseReclaimGuard(guard);
    }
  }

  private async acquireReclaimGuard(): Promise<ReclaimGuard | undefined> {
    const guardPath = `${this.filePath}.reclaim`;
    try {
      await fs.mkdir(guardPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const record = await readGuardRecord(guardPath);
      if (record && isRunning(record.pid)) return undefined;
      const info = await fs.lstat(guardPath).catch(() => undefined);
      if (!record && info && Date.now() - info.mtimeMs < 5_000) return undefined;
      const stalePath = `${guardPath}.stale.${randomUUID()}`;
      try {
        await fs.rename(guardPath, stalePath);
      } catch (renameError) {
        if (isNodeError(renameError) && renameError.code === "ENOENT") return undefined;
        throw renameError;
      }
      try {
        await fs.mkdir(guardPath, { mode: 0o700 });
      } catch (createError) {
        if (isNodeError(createError) && createError.code === "EEXIST") return undefined;
        throw createError;
      } finally {
        await fs.rm(stalePath, { recursive: true, force: true });
      }
    }
    const token = randomUUID();
    const record: LockRecord = { pid: process.pid, token, createdAt: new Date().toISOString() };
    try {
      await fs.writeFile(
        path.join(guardPath, "owner.json"),
        `${JSON.stringify(record)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return { path: guardPath, token };
    } catch (error) {
      await fs.rm(guardPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async releaseReclaimGuard(guard: ReclaimGuard): Promise<void> {
    const current = await readGuardRecord(guard.path);
    if (current?.token === guard.token) {
      await fs.rm(guard.path, { recursive: true, force: true });
    }
  }

  private async readRecord(): Promise<LockRecord | undefined> {
    return readRecordAt(this.filePath);
  }
}

async function readGuardRecord(guardPath: string): Promise<LockRecord | undefined> {
  const info = await fs.lstat(guardPath).catch(() => undefined);
  if (!info) return undefined;
  return info.isDirectory()
    ? readRecordAt(path.join(guardPath, "owner.json"))
    : readRecordAt(guardPath);
}

async function readRecordAt(filePath: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<LockRecord>;
    return typeof value.pid === "number" && typeof value.token === "string"
      ? value as LockRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function lockedError(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Another Safe WhatsApp MCP process is already using this state directory.",
    "state_locked",
  );
}

function isRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}
