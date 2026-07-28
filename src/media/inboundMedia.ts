// Agent context note: Streams inbound media through a hard cap, signature-verifies safe inline MIME, reauthorizes after async boundaries, and reconciles caches. Tests: test/media.test.mjs and test/mcp-tools.test.mjs. Unsafe roots, view-once, deleted, expired, unavailable, oversized, or unverified inline media must never be returned; update this note after meaningful behavior changes.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { SafeWhatsAppError } from "../errors.js";
import {
  InboundMediaMetadata,
  InboundMediaResult,
  InboundMediaSource,
  RetainedMediaDescriptor,
} from "./types.js";
import { MAX_MEDIA_BYTES } from "./outbox.js";

export const MAX_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;
const TEMP_ARTIFACT_GRACE_MS = 5 * 60_000;
const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SAFE_INLINE_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

export interface InboundMediaReader {
  get(messageId: string): Promise<InboundMediaResult>;
  readResource(messageId: string): Promise<{ metadata: InboundMediaMetadata; bytes: Uint8Array }>;
}

interface CachedMediaRecord {
  metadata: InboundMediaMetadata;
  cachedAt: string;
}

export class InboundMediaService implements InboundMediaReader {
  constructor(
    private readonly source: InboundMediaSource,
    private readonly mediaDir: string,
    private readonly maxInlineBytes = MAX_INLINE_MEDIA_BYTES,
    private readonly maxBytes = MAX_MEDIA_BYTES,
  ) {}

  async get(messageId: string): Promise<InboundMediaResult> {
    const { descriptor, bytes, metadata, inlineSafe } = await this.downloadAllowed(messageId);
    if (inlineSafe && bytes.byteLength <= this.maxInlineBytes) {
      return { delivery: "inline", metadata, bytes };
    }
    await this.cache(messageId, bytes, metadata);
    try {
      await this.assertAllowed(messageId);
    } catch (error) {
      await this.removeCache(messageId);
      throw error;
    }
    return {
      delivery: "resource",
      metadata,
      uri: mediaResourceUri(descriptor.messageId),
    };
  }

  async readResource(messageId: string): Promise<{ metadata: InboundMediaMetadata; bytes: Uint8Array }> {
    await this.assertAllowed(messageId);
    const paths = await this.cachePaths(messageId, false);
    try {
      const [bytes, rawMetadata] = await Promise.all([
        readNoFollow(paths.data),
        readNoFollow(paths.metadata),
      ]);
      const cached = JSON.parse(rawMetadata.toString("utf8")) as CachedMediaRecord;
      const metadata = cached.metadata;
      if (bytes.byteLength !== metadata.size || digest(bytes) !== metadata.sha256) {
        await this.removeCache(messageId);
        throw new SafeWhatsAppError("Cached media is unavailable.", "media_unavailable");
      }
      const current = await this.assertAllowed(messageId);
      return { metadata: { ...metadata, mediaType: current.mediaType }, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SafeWhatsAppError("Download the media before reading its resource.", "media_not_downloaded");
      }
      throw error;
    }
  }

  private async downloadAllowed(messageId: string): Promise<{
    descriptor: RetainedMediaDescriptor;
    bytes: Uint8Array;
    metadata: InboundMediaMetadata;
    inlineSafe: boolean;
  }> {
    const descriptor = await this.assertAllowed(messageId);
    if (descriptor.size !== undefined && descriptor.size > this.maxBytes) {
      throw new SafeWhatsAppError("Media exceeds the 25 MiB limit.", "media_too_large");
    }
    const bytes = await collectLimited(await this.source.download(messageId, this.maxBytes), this.maxBytes);
    const detectedMime = await sniffMimeType(bytes);
    const current = await this.assertAllowed(messageId);
    const declaredMime = normalizeMimeType(current.mimeType);
    const metadata: InboundMediaMetadata = {
      messageId: current.messageId,
      fileName: cleanOptionalName(current.fileName),
      mimeType: detectedMime ?? "application/octet-stream",
      size: bytes.byteLength,
      mediaType: current.mediaType,
      sha256: digest(bytes),
    };
    return {
      descriptor: current,
      bytes,
      metadata,
      inlineSafe: isSafeInlineMedia(current.mediaType, declaredMime, detectedMime),
    };
  }

  private async assertAllowed(messageId: string): Promise<RetainedMediaDescriptor> {
    if (!messageId || messageId.length > 512) {
      throw new SafeWhatsAppError("Invalid message ID.", "invalid_message_id");
    }
    const descriptor = await this.source.describe(messageId);
    if (!descriptor) {
      await this.removeCache(messageId);
      throw new SafeWhatsAppError("Media was not found.", "media_not_found");
    }
    if (descriptor.viewOnce) {
      await this.removeCache(messageId);
      throw new SafeWhatsAppError("View-once media cannot be accessed.", "view_once_refused");
    }
    if (descriptor.deleted) {
      await this.removeCache(messageId);
      throw new SafeWhatsAppError("The media message was deleted.", "media_deleted");
    }
    if (descriptor.expired) {
      await this.removeCache(messageId);
      throw new SafeWhatsAppError("The media message expired.", "media_expired");
    }
    if (descriptor.size !== undefined && descriptor.size > this.maxBytes) {
      await this.removeCache(messageId);
      throw new SafeWhatsAppError("Media exceeds the 25 MiB limit.", "media_too_large");
    }
    return descriptor;
  }

  private async cache(messageId: string, bytes: Uint8Array, metadata: InboundMediaMetadata): Promise<void> {
    const paths = await this.cachePaths(messageId, true);
    await atomicWrite(paths.data, bytes);
    await atomicWrite(paths.metadata, Buffer.from(JSON.stringify({
      metadata,
      cachedAt: new Date().toISOString(),
    } satisfies CachedMediaRecord), "utf8"));
  }

  private async removeCache(messageId: string): Promise<void> {
    const paths = await this.cachePaths(messageId, false);
    await Promise.all([unlinkIfExists(paths.data), unlinkIfExists(paths.metadata)]);
  }

  async removeCached(messageId: string): Promise<void> {
    await this.removeCache(messageId);
  }

  async reconcile(
    retainedMessageIds: Iterable<string>,
    cachedOnOrAfter?: Date,
    now = new Date(),
  ): Promise<{ removed: number }> {
    const retained = new Set(retainedMessageIds);
    const root = await this.safeMediaDirectory(true);
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const temporary = /^[0-9a-f]{64}\.(?:bin|json)\.\d+\.([0-9a-f-]{36})\.tmp$/iu.exec(entry.name);
      if (!temporary || !isUuid(temporary[1])) continue;
      const candidate = path.join(root, entry.name);
      const stat = await fs.lstat(candidate);
      if ((stat.isFile() || stat.isSymbolicLink()) &&
          stat.mtimeMs <= now.getTime() - TEMP_ARTIFACT_GRACE_MS) {
        await fs.unlink(candidate);
      }
    }
    const keys = new Set(
      entries
        .map((entry) => /^([0-9a-f]{64})\.(?:bin|json)$/u.exec(entry.name)?.[1])
        .filter((key): key is string => Boolean(key)),
    );
    let removed = 0;
    for (const key of keys) {
      const data = path.join(root, `${key}.bin`);
      const metadataPath = path.join(root, `${key}.json`);
      let keep = false;
      try {
        const [bytes, raw] = await Promise.all([readNoFollow(data), readNoFollow(metadataPath)]);
        const cached = JSON.parse(raw.toString("utf8")) as CachedMediaRecord;
        const metadata = cached.metadata;
        keep =
          typeof metadata?.messageId === "string" &&
          retained.has(metadata.messageId) &&
          bytes.byteLength === metadata.size &&
          digest(bytes) === metadata.sha256 &&
          (!cachedOnOrAfter || Date.parse(cached.cachedAt) >= cachedOnOrAfter.getTime());
      } catch {
        keep = false;
      }
      if (keep) continue;
      await Promise.all([unlinkIfExists(data), unlinkIfExists(metadataPath)]);
      removed += 1;
    }
    return { removed };
  }

  private async cachePaths(messageId: string, create: boolean): Promise<{ data: string; metadata: string }> {
    const key = digest(Buffer.from(messageId, "utf8"));
    const root = await this.safeMediaDirectory(create);
    return {
      data: path.join(root, `${key}.bin`),
      metadata: path.join(root, `${key}.json`),
    };
  }

  private async safeMediaDirectory(create: boolean): Promise<string> {
    const root = path.resolve(this.mediaDir);
    if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = await fs.lstat(root);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return root;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SafeWhatsAppError("The inbound media cache directory is unsafe.", "unsafe_media_cache");
    }
    return path.resolve(await fs.realpath(root));
  }
}

export function mediaResourceUri(messageId: string): string {
  return `whatsapp-media://message/${encodeURIComponent(messageId)}`;
}

async function sniffMimeType(bytes: Uint8Array): Promise<string | undefined> {
  try {
    return normalizeMimeType((await fileTypeFromBuffer(bytes))?.mime);
  } catch {
    return undefined;
  }
}

function isSafeInlineMedia(
  mediaType: RetainedMediaDescriptor["mediaType"],
  declaredMime: string | undefined,
  detectedMime: string | undefined,
): boolean {
  if (!detectedMime || (declaredMime && declaredMime !== detectedMime)) return false;
  if (mediaType === "image" || mediaType === "sticker") {
    return SAFE_INLINE_IMAGE_TYPES.has(detectedMime);
  }
  return mediaType === "audio" && SAFE_INLINE_AUDIO_TYPES.has(detectedMime);
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime) return undefined;
  if (mime === "image/jpg") return "image/jpeg";
  if (mime === "audio/x-wav") return "audio/wav";
  return mime;
}

function cleanOptionalName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.basename(value).replace(/[\u0000-\u001f\u007f]/gu, "_").slice(0, 255) || undefined;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicWrite(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readNoFollow(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SafeWhatsAppError("Cached media is unavailable.", "media_unavailable");
    return await handle.readFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new SafeWhatsAppError("Cached media is unavailable.", "media_unavailable");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function collectLimited(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new SafeWhatsAppError("WhatsApp returned invalid media data.", "media_unavailable");
    }
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new SafeWhatsAppError("Media exceeds the 25 MiB limit.", "media_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
