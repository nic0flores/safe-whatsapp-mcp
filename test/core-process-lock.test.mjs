import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProcessLock } from "../dist/storage/processLock.js";

const execFileAsync = promisify(execFile);

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

test("a lock-record symlink is reclaimed without reading or changing its target", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation requires elevated Windows privileges");
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  const targetPath = path.join(root, "outside.json");
  const outside = JSON.stringify({ pid: process.pid, token: "outside", createdAt: "old" });
  const lock = new ProcessLock(lockPath);
  try {
    await writeFile(targetPath, outside, { mode: 0o600 });
    await symlink(targetPath, lockPath);
    await lock.acquire();
    assert.equal((await lstat(lockPath)).isFile(), true);
    assert.equal(await readFile(targetPath, "utf8"), outside);
  } finally {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized live lock record is not read as trusted metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  const lock = new ProcessLock(lockPath);
  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "x".repeat(8_192), createdAt: "old" }),
      { mode: 0o600 },
    );
    await lock.acquire();
    assert.equal((await lstat(lockPath)).isFile(), true);
  } finally {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a named-pipe lock record is reclaimed without blocking on special-file input", async (t) => {
  if (process.platform === "win32") return t.skip("named pipes use a different filesystem model on Windows");
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-lock-"));
  const lockPath = path.join(root, "process.lock");
  const lock = new ProcessLock(lockPath);
  let pipe;
  try {
    try {
      await execFileAsync("mkfifo", [lockPath]);
    } catch {
      return t.skip("mkfifo is unavailable");
    }
    pipe = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    await pipe.writeFile(JSON.stringify({ pid: process.pid, token: "pipe", createdAt: "old" }));
    const closePipe = new Promise((resolve) => {
      setTimeout(() => pipe.close().then(resolve, resolve), 50);
    });
    await lock.acquire();
    await closePipe;
    pipe = undefined;
    assert.equal((await lstat(lockPath)).isFile(), true);
  } finally {
    await pipe?.close().catch(() => undefined);
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});
