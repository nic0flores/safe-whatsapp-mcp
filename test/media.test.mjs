import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientMediaSource } from "../dist/media/clientMediaSource.js";
import { InboundMediaService } from "../dist/media/inboundMedia.js";
import { OutboxMediaService } from "../dist/media/outbox.js";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG_BYTES = Buffer.from("ffd8ffe000104a4649460001", "hex");
const WAV_BYTES = Buffer.from("524946462400000057415645666d7420", "hex");

test("client media adapter maps descriptors and forwards the hard byte cap", async () => {
  const calls = [];
  const source = new ClientMediaSource({
    getRetainedMediaDescriptor(messageId) {
      return {
        messageId,
        kind: "audio",
        mime: "audio/ogg",
        filename: "voice.ogg",
        size: 42,
      };
    },
    async downloadRetainedMedia(messageId, maxBytes) {
      calls.push({ messageId, maxBytes });
      return (async function* () { yield Buffer.from("voice"); })();
    },
  });

  assert.deepEqual(await source.describe("m1"), {
    messageId: "m1",
    mediaType: "audio",
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
    size: 42,
  });
  for await (const _chunk of await source.download("m1", 123)) {}
  assert.deepEqual(calls, [{ messageId: "m1", maxBytes: 123 }]);
});

test("outbox media is confined, snapshotted, and hash verified", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-media-"));
  const outbox = path.join(root, "outbox");
  const pending = path.join(root, "pending");
  await fs.mkdir(path.join(outbox, "nested"), { recursive: true });
  const png = PNG_BYTES;
  await fs.writeFile(path.join(outbox, "nested", "photo.png"), png);
  const service = new OutboxMediaService(outbox, pending);

  const snapshot = await service.snapshot("nested/photo.png", "11111111-1111-4111-8111-111111111111");
  assert.equal(snapshot.kind, "image");
  assert.equal(snapshot.mimeType, "image/png");
  assert.equal(snapshot.size, png.length);
  assert.deepEqual(Buffer.from((await service.readVerified(snapshot, snapshot.pendingId)).bytes), png);

  await fs.writeFile(snapshot.path, Buffer.from("changed"));
  await assert.rejects(() => service.readVerified(snapshot, snapshot.pendingId), /snapshot changed/i);
  await assert.rejects(() => service.snapshot("../secret", "22222222-2222-4222-8222-222222222222"), /traversal/i);
});

test("review uploads are bounded, sniffed, hashed, and atomically replace only their ID snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-review-upload-"));
  const service = new OutboxMediaService(
    path.join(root, "outbox"),
    path.join(root, "pending"),
  );
  const pendingId = "12121212-1212-4121-8121-121212121212";
  const initial = await service.snapshotBytes(PNG_BYTES, "../photo.png", pendingId);
  assert.equal(initial.originalName, ".._photo.png");
  assert.equal(initial.kind, "image");
  assert.equal(initial.mimeType, "image/png");
  assert.equal(initial.sha256, createSha256(PNG_BYTES));

  const replacement = await service.snapshotBytes(WAV_BYTES, "voice.wav", pendingId);
  assert.equal(replacement.path, initial.path);
  assert.equal(replacement.kind, "audio");
  assert.equal(replacement.mimeType, "audio/wav");
  assert.equal(replacement.sha256, createSha256(WAV_BYTES));
  assert.deepEqual(
    Buffer.from((await service.readVerified(replacement, pendingId)).bytes),
    WAV_BYTES,
  );
  await assert.rejects(() => service.readVerified(initial, pendingId), /snapshot changed/i);

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(replacement.path)).mode & 0o777, 0o600);
  }

  const small = new OutboxMediaService(
    path.join(root, "small-outbox"),
    path.join(root, "small-pending"),
    4,
  );
  await assert.rejects(
    () => small.snapshotBytes(Buffer.alloc(5), "too-large.bin", "13131313-1313-4131-8131-131313131313"),
    /exceeds/i,
  );
  await assert.rejects(
    () => service.snapshotBytes(PNG_BYTES, "", "14141414-1414-4141-8141-141414141414"),
    /filename is invalid/i,
  );
});

test("outbox refuses symlinks", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-link-"));
  const outbox = path.join(root, "outbox");
  await fs.mkdir(outbox);
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(outbox, "link.txt"));
  const service = new OutboxMediaService(outbox, path.join(root, "pending"));

  await assert.rejects(
    () => service.snapshot("link.txt", "33333333-3333-4333-8333-333333333333"),
    /symlink/i,
  );
});

test("outbox and pending media roots refuse symlinks", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-root-link-"));
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "file.txt"), "outside");
  const outboxLink = path.join(root, "outbox");
  await fs.symlink(outside, outboxLink);
  const outboxService = new OutboxMediaService(outboxLink, path.join(root, "pending"));
  await assert.rejects(
    () => outboxService.snapshot("file.txt", "44444444-4444-4444-8444-444444444444"),
    /outbox directory is unsafe/i,
  );

  const safeOutbox = path.join(root, "safe-outbox");
  await fs.mkdir(safeOutbox);
  await fs.writeFile(path.join(safeOutbox, "file.txt"), "safe");
  const pendingLink = path.join(root, "pending-link");
  await fs.symlink(outside, pendingLink);
  const pendingService = new OutboxMediaService(safeOutbox, pendingLink);
  await assert.rejects(
    () => pendingService.snapshot("file.txt", "55555555-5555-4555-8555-555555555555"),
    /pending directory is unsafe/i,
  );
});

test("removeSnapshot rejects a forged outside path without deleting it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-forged-"));
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "do not delete");
  const service = new OutboxMediaService(path.join(root, "outbox"), path.join(root, "pending"));
  const pendingId = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(
    () => service.removeSnapshot({
      pendingId,
      path: outside,
      originalName: "outside.txt",
      sha256: "a".repeat(64),
      size: 13,
      mimeType: "text/plain",
      kind: "document",
    }, pendingId),
    /path is invalid/i,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "do not delete");
});

test("inbound media refuses view-once and returns inline image bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-inbound-"));
  const source = new FakeMediaSource();
  source.descriptors.set("view", { messageId: "view", mediaType: "image", viewOnce: true });
  source.descriptors.set("image", { messageId: "image", mediaType: "image", mimeType: "image/png" });
  source.bytes.set("image", PNG_BYTES);
  const service = new InboundMediaService(source, root);

  await assert.rejects(() => service.get("view"), /view-once/i);
  const result = await service.get("image");
  assert.equal(result.delivery, "inline");
  assert.equal(result.metadata.mimeType, "image/png");
  assert.deepEqual(Buffer.from(result.bytes), PNG_BYTES);
  assert.equal(source.downloads, 1);
});

test("inbound media rechecks deletion after download before returning or caching bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-revoked-download-"));
  let deleted = false;
  const source = {
    async describe(messageId) {
      return { messageId, mediaType: "image", mimeType: "image/png", deleted };
    },
    async download() {
      return (async function* () {
        yield PNG_BYTES;
        deleted = true;
      })();
    },
  };
  const service = new InboundMediaService(source, root);

  await assert.rejects(() => service.get("revoked-during-download"), /deleted/i);
  assert.deepEqual(await fs.readdir(root), []);
});

test("inbound rich media requires a matching safe byte signature and media kind", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-sniffed-"));
  const source = new FakeMediaSource();
  const cases = [
    {
      id: "audio",
      descriptor: { mediaType: "audio", mimeType: "audio/wav" },
      bytes: WAV_BYTES,
      delivery: "inline",
      mimeType: "audio/wav",
    },
    {
      id: "mismatch",
      descriptor: { mediaType: "image", mimeType: "image/png" },
      bytes: JPEG_BYTES,
      delivery: "resource",
      mimeType: "image/jpeg",
    },
    {
      id: "document-image",
      descriptor: { mediaType: "document", mimeType: "image/png" },
      bytes: PNG_BYTES,
      delivery: "resource",
      mimeType: "image/png",
    },
    {
      id: "svg",
      descriptor: { mediaType: "image", mimeType: "image/svg+xml" },
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      delivery: "resource",
      mimeType: "application/octet-stream",
    },
  ];
  for (const item of cases) {
    source.descriptors.set(item.id, { messageId: item.id, ...item.descriptor });
    source.bytes.set(item.id, item.bytes);
  }
  const service = new InboundMediaService(source, root);

  for (const item of cases) {
    const result = await service.get(item.id);
    assert.equal(result.delivery, item.delivery, item.id);
    assert.equal(result.metadata.mimeType, item.mimeType, item.id);
  }
});

test("inbound documents use an opaque resource and revoked media invalidates it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-resource-"));
  const source = new FakeMediaSource();
  source.descriptors.set("doc/id", {
    messageId: "doc/id",
    mediaType: "document",
    mimeType: "application/pdf",
    fileName: "report.pdf",
  });
  source.bytes.set("doc/id", Buffer.from("pdf bytes"));
  const service = new InboundMediaService(source, root);

  const result = await service.get("doc/id");
  assert.equal(result.delivery, "resource");
  assert.equal(result.uri, "whatsapp-media://message/doc%2Fid");
  assert.deepEqual(Buffer.from((await service.readResource("doc/id")).bytes), Buffer.from("pdf bytes"));

  source.descriptors.get("doc/id").deleted = true;
  await assert.rejects(() => service.readResource("doc/id"), /deleted/i);
});

test("resource reads recheck deletion after asynchronous cache reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-revoked-resource-"));
  let describeCalls = 0;
  const source = {
    async describe(messageId) {
      describeCalls += 1;
      return {
        messageId,
        mediaType: "document",
        mimeType: "application/pdf",
        deleted: describeCalls >= 5,
      };
    },
    async download() {
      return (async function* () { yield Buffer.from("opaque document"); })();
    },
  };
  const service = new InboundMediaService(source, root);
  assert.equal((await service.get("revoked-during-read")).delivery, "resource");

  await assert.rejects(() => service.readResource("revoked-during-read"), /deleted/i);
  assert.deepEqual(await fs.readdir(root), []);
});

test("inbound streaming aborts as soon as the byte limit is crossed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-limit-"));
  let aborted = false;
  const iterator = {
    index: 0,
    async next() {
      this.index += 1;
      return this.index <= 3
        ? { done: false, value: Buffer.alloc(4) }
        : { done: true, value: undefined };
    },
    async return() {
      aborted = true;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() { return this; },
  };
  const source = {
    async describe(messageId) { return { messageId, mediaType: "document" }; },
    async download() { return iterator; },
  };
  const service = new InboundMediaService(source, root, 5, 5);

  await assert.rejects(() => service.get("large"), /exceeds/i);
  assert.equal(iterator.index, 2);
  assert.equal(aborted, true);
});

test("inbound cache reconciliation removes bytes outside retained message IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-retention-"));
  const source = new FakeMediaSource();
  source.descriptors.set("old", { messageId: "old", mediaType: "document" });
  source.bytes.set("old", Buffer.from("old attachment"));
  const service = new InboundMediaService(source, root);
  await service.get("old");

  assert.deepEqual(await service.reconcile([]), { removed: 1 });
  await assert.rejects(() => service.readResource("old"), /download.*before reading/i);
});

test("inbound cache commit is atomic with concurrent broker reconciliation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-cache-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = new FakeMediaSource();
  source.descriptors.set("shared", { messageId: "shared", mediaType: "document" });
  source.bytes.set("shared", Buffer.from("shared attachment"));
  let markDataCached;
  let releaseCommit;
  const dataCached = new Promise((resolve) => { markDataCached = resolve; });
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  class PausedInboundMediaService extends InboundMediaService {
    async afterDataCached() {
      markDataCached();
      await commitGate;
    }
  }
  const service = new PausedInboundMediaService(source, root);

  const download = service.get("shared");
  await dataCached;
  let reconciliationFinished = false;
  const reconciliation = service.reconcile(["shared"])
    .then((result) => {
      reconciliationFinished = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconciliationFinished, false);

  releaseCommit();
  assert.equal((await download).delivery, "resource");
  assert.deepEqual(await reconciliation, { removed: 0 });
  assert.deepEqual(
    Buffer.from((await service.readResource("shared")).bytes),
    Buffer.from("shared attachment"),
  );
});

test("a missing retained descriptor invalidates an existing media cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-missing-"));
  const source = new FakeMediaSource();
  source.descriptors.set("gone", { messageId: "gone", mediaType: "document" });
  source.bytes.set("gone", Buffer.from("cached bytes"));
  const service = new InboundMediaService(source, root);
  await service.get("gone");
  source.descriptors.delete("gone");

  await assert.rejects(() => service.readResource("gone"), /not found/i);
  assert.equal((await fs.readdir(root)).length, 0);
});

test("inbound cache root refuses symlinks", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-cache-link-"));
  const outside = path.join(root, "outside");
  const cacheLink = path.join(root, "cache");
  await fs.mkdir(outside);
  await fs.symlink(outside, cacheLink);
  const source = new FakeMediaSource();
  source.descriptors.set("doc", { messageId: "doc", mediaType: "document" });
  source.bytes.set("doc", Buffer.from("bytes"));
  const service = new InboundMediaService(source, cacheLink);
  await assert.rejects(() => service.get("doc"), /cache directory is unsafe/i);
});

test("inbound reconciliation removes stale cache temps but preserves fresh writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-cache-temp-"));
  const source = new FakeMediaSource();
  const service = new InboundMediaService(source, root);
  const oldTemp = path.join(
    root,
    `${"a".repeat(64)}.bin.123.11111111-1111-4111-8111-111111111111.tmp`,
  );
  const freshTemp = path.join(
    root,
    `${"b".repeat(64)}.json.123.22222222-2222-4222-8222-222222222222.tmp`,
  );
  await fs.writeFile(oldTemp, "stale plaintext media");
  await fs.writeFile(freshTemp, "active write");
  const now = new Date("2026-01-01T00:10:00.000Z");
  const oldTime = new Date(now.getTime() - 6 * 60_000);
  await fs.utimes(oldTemp, oldTime, oldTime);
  await fs.utimes(freshTemp, now, now);

  await service.reconcile([], undefined, now);
  await assert.rejects(() => fs.access(oldTemp), /ENOENT/u);
  await fs.access(freshTemp);
});

class FakeMediaSource {
  descriptors = new Map();
  bytes = new Map();
  downloads = 0;

  async describe(id) {
    return this.descriptors.get(id);
  }

  async download(id) {
    this.downloads += 1;
    const value = this.bytes.get(id);
    if (!value) throw new Error("missing fake bytes");
    return (async function* () { yield value; })();
  }
}

function createSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
