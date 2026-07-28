// Agent context note: Confines outbound files and reconciles ID/hash-bound snapshots plus stale snapshot temps. Tests: test/media.test.mjs and test/send-service.test.mjs. Reject unsafe roots, symlinks, and forged record paths; update this note after meaningful behavior changes.
import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { SafeWhatsAppError } from "../errors.js";
import {
  OutboundMediaContent,
  OutboundMediaKind,
  OutboundMediaSnapshot,
} from "./types.js";

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const TEMP_ARTIFACT_GRACE_MS = 5 * 60_000;

export class OutboxMediaService {
  private readonly reservedSnapshots = new Set<string>();

  constructor(
    private readonly outboxDir: string,
    private readonly pendingDir: string,
    private readonly maxBytes = MAX_MEDIA_BYTES,
  ) {}

  async snapshot(relativePath: string, pendingId: string): Promise<OutboundMediaSnapshot> {
    assertPendingId(pendingId);
    this.reservedSnapshots.add(pendingId);
    try {
      const sourcePath = await this.resolveOutboxFile(relativePath);
      const bytes = await readRegularFile(sourcePath, this.maxBytes);
      const detected = await fileTypeFromBuffer(bytes);
      const mimeType = detected?.mime ?? "application/octet-stream";
      const originalName = safeFileName(path.basename(sourcePath));
      const snapshotPath = await this.expectedSnapshotPath(pendingId, true);

      await writePrivateFile(snapshotPath, bytes);
      return {
        pendingId,
        path: snapshotPath,
        originalName,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        mimeType,
        kind: mediaKind(mimeType),
      };
    } catch (error) {
      this.reservedSnapshots.delete(pendingId);
      throw error;
    }
  }

  async readVerified(snapshot: OutboundMediaSnapshot, pendingId: string): Promise<OutboundMediaContent> {
    const snapshotPath = await this.assertSnapshotPath(snapshot, pendingId);
    const bytes = await readRegularFile(snapshotPath, this.maxBytes);
    if (bytes.byteLength !== snapshot.size || sha256(bytes) !== snapshot.sha256) {
      throw new SafeWhatsAppError(
        "The staged media snapshot changed. Prepare the message again.",
        "media_snapshot_mismatch",
      );
    }
    return {
      bytes,
      originalName: snapshot.originalName,
      sha256: snapshot.sha256,
      size: snapshot.size,
      mimeType: snapshot.mimeType,
      kind: snapshot.kind,
    };
  }

  async removeSnapshot(snapshot: OutboundMediaSnapshot | undefined, pendingId: string): Promise<void> {
    assertPendingId(pendingId);
    this.reservedSnapshots.delete(pendingId);
    if (!snapshot) return;
    const snapshotPath = await this.assertSnapshotPath(snapshot, pendingId);
    try {
      await fs.unlink(snapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async reconcileSnapshots(
    referencedPendingIds: ReadonlySet<string>,
    now = new Date(),
  ): Promise<string[]> {
    const snapshotDir = await this.safeSnapshotDirectory(true);
    const removed: string[] = [];
    for (const entry of await fs.readdir(snapshotDir, { withFileTypes: true })) {
      const temporary = /^([0-9a-f-]{36})\.bin\.\d+\.([0-9a-f-]{36})\.tmp$/iu.exec(entry.name);
      if (temporary && isPendingId(temporary[1]) && isPendingId(temporary[2])) {
        const candidate = path.join(snapshotDir, entry.name);
        const stat = await fs.lstat(candidate);
        if ((stat.isFile() || stat.isSymbolicLink()) &&
            stat.mtimeMs <= now.getTime() - TEMP_ARTIFACT_GRACE_MS) {
          await fs.unlink(candidate);
        }
        continue;
      }
      const match = /^([0-9a-f-]{36})\.bin$/iu.exec(entry.name);
      if (!match || !isPendingId(match[1])) continue;
      const pendingId = match[1];
      if (referencedPendingIds.has(pendingId) || this.reservedSnapshots.has(pendingId)) continue;
      const candidate = path.join(snapshotDir, entry.name);
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      await fs.unlink(candidate);
      removed.push(pendingId);
    }
    return removed;
  }

  private async assertSnapshotPath(
    snapshot: OutboundMediaSnapshot,
    pendingId: string,
  ): Promise<string> {
    if (snapshot.pendingId !== pendingId) {
      throw new SafeWhatsAppError("The staged media path is invalid.", "invalid_snapshot_path");
    }
    const expected = await this.expectedSnapshotPath(pendingId, false);
    if (path.resolve(snapshot.path) !== expected) {
      throw new SafeWhatsAppError("The staged media path is invalid.", "invalid_snapshot_path");
    }
    return expected;
  }

  private async expectedSnapshotPath(pendingId: string, create: boolean): Promise<string> {
    assertPendingId(pendingId);
    return path.join(await this.safeSnapshotDirectory(create), `${pendingId}.bin`);
  }

  private async safeSnapshotDirectory(create: boolean): Promise<string> {
    const pendingRoot = path.resolve(this.pendingDir);
    if (create) await fs.mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    let pendingStat;
    try {
      pendingStat = await fs.lstat(pendingRoot);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return path.join(pendingRoot, "media");
      }
      throw error;
    }
    if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()) {
      throw new SafeWhatsAppError("The pending directory is unsafe.", "unsafe_pending_directory");
    }
    await fs.realpath(pendingRoot);
    const snapshotDir = path.join(pendingRoot, "media");
    if (create) await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = await fs.lstat(snapshotDir);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return snapshotDir;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SafeWhatsAppError("The pending media directory is unsafe.", "unsafe_pending_media_directory");
    }
    await fs.realpath(snapshotDir);
    return path.resolve(snapshotDir);
  }

  private async resolveOutboxFile(relativePath: string): Promise<string> {
    const segments = parseRelativePath(relativePath);
    await fs.mkdir(this.outboxDir, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.outboxDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new SafeWhatsAppError("The outbox directory is unsafe.", "unsafe_outbox_directory");
    }
    const outboxReal = await fs.realpath(this.outboxDir);
    let candidate = outboxReal;
    for (const segment of segments) {
      candidate = path.join(candidate, segment);
      let stat;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new SafeWhatsAppError("The outbox file was not found.", "outbox_file_not_found");
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new SafeWhatsAppError("Outbox symlinks are not allowed.", "outbox_symlink_refused");
      }
    }

    const real = await fs.realpath(candidate);
    if (!isInside(outboxReal, real)) {
      throw new SafeWhatsAppError("The media path must remain inside the outbox.", "outbox_escape_refused");
    }
    return real;
  }
}

function parseRelativePath(value: string): string[] {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new SafeWhatsAppError("Provide a relative path inside the outbox.", "invalid_outbox_path");
  }
  const segments = value.split(/[\\/]+/u);
  if (segments.some((part) => !part || part === "." || part === "..")) {
    throw new SafeWhatsAppError("Outbox path traversal is not allowed.", "invalid_outbox_path");
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SafeWhatsAppError("Media must be a regular file.", "media_not_regular_file");
    }
    if (stat.size > maxBytes) {
      throw new SafeWhatsAppError("Media exceeds the 25 MiB limit.", "media_too_large");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new SafeWhatsAppError("Media exceeds the 25 MiB limit.", "media_too_large");
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SafeWhatsAppError("Media symlinks are not allowed.", "media_symlink_refused");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writePrivateFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 255);
  return cleaned || "attachment";
}

function mediaKind(mimeType: string): OutboundMediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPendingId(id: string): void {
  if (!isPendingId(id)) {
    throw new SafeWhatsAppError("Invalid pending send ID.", "invalid_pending_id");
  }
}

function isPendingId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
}
