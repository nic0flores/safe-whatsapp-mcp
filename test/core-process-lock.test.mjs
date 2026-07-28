import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessLock } from "../dist/storage/processLock.js";

test("a live process lock excludes another writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  const first = new ProcessLock(lockPath);
  const second = new ProcessLock(lockPath);
  try {
    await first.acquire();
    await assert.rejects(second.acquire(), (error) => error.code === "state_locked");
  } finally {
    await first.release();
    await second.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stale-lock contenders yield exactly one owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale", createdAt: "old" }), { mode: 0o600 });
  const contenders = [new ProcessLock(lockPath), new ProcessLock(lockPath)];
  try {
    const results = await Promise.allSettled(contenders.map((lock) => lock.acquire()));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  } finally {
    await Promise.all(contenders.map((lock) => lock.release()));
    await rm(root, { recursive: true, force: true });
  }
});

test("a reclaim guard left by a crashed process is recoverable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  const guardPath = `${lockPath}.reclaim`;
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale-main" }), { mode: 0o600 });
  await mkdir(guardPath, { mode: 0o700 });
  await writeFile(
    path.join(guardPath, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "stale-guard" }),
    { mode: 0o600 },
  );
  const lock = new ProcessLock(lockPath);
  try {
    await lock.acquire();
    await assert.rejects(new ProcessLock(lockPath).acquire(), (error) => error.code === "state_locked");
  } finally {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});
