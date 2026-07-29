import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureStateOwnership } from "../dist/storage/accountState.js";
import { StatePaths } from "../dist/storage/paths.js";
import { purgeLocalState, WhatsAppCore } from "../dist/whatsapp/core.js";
import { MemoryMasterKeyStore } from "./core-helpers.mjs";

test("StatePaths rejects relative, filesystem-root, and home-directory targets", () => {
  assert.throws(() => new StatePaths("relative/state"), /absolute path/);
  assert.throws(() => new StatePaths(path.parse(process.cwd()).root), /filesystem root/);
  assert.throws(() => new StatePaths(os.homedir()), /home directory/);
});

test("StatePaths rejects a symbolic-link state root", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-path-link-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await mkdir(target);
  await symlink(target, link);
  try {
    assert.throws(() => new StatePaths(link), (error) => error.code === "invalid_state_directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purge removes exact local state while preserving the user-managed outbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-purge-"));
  const paths = new StatePaths(root);
  await mkdir(paths.mediaDir, { recursive: true });
  await mkdir(paths.pendingDir, { recursive: true });
  await mkdir(paths.outboxDir, { recursive: true });
  await ensureStateOwnership(paths);
  await Promise.all([
    writeFile(paths.configFile, "{}"),
    writeFile(paths.databaseFile, "db"),
    writeFile(paths.auditFile, "audit"),
    writeFile(paths.brokerFile, "stale broker"),
    writeFile(path.join(paths.mediaDir, "media"), "media"),
    writeFile(path.join(paths.pendingDir, "pending"), "pending"),
    writeFile(path.join(paths.outboxDir, "keep.txt"), "keep"),
    writeFile(path.join(root, ".config.json.1.crash.tmp"), "temp"),
    writeFile(path.join(root, ".config.json.1.33333333-3333-4333-8333-333333333333.tmp"), "temp"),
    writeFile(path.join(root, "audit.log.1.11111111-1111-4111-8111-111111111111.tmp"), "temp"),
    writeFile(path.join(root, "process.lock.candidate.crash"), "temp"),
    writeFile(path.join(root, "process.lock.candidate.44444444-4444-4444-8444-444444444444"), "temp"),
    writeFile(path.join(root, ".broker.json.1.55555555-5555-4555-8555-555555555555.tmp"), "temp"),
    writeFile(path.join(root, "broker-launch.lock.candidate.66666666-6666-4666-8666-666666666666"), "temp"),
    mkdir(path.join(root, "broker-launch.lock.reclaim.stale.77777777-7777-4777-8777-777777777777")),
    writeFile(path.join(root, "audit.log.notes.tmp"), "keep"),
    writeFile(path.join(root, ".config.json.notes.tmp"), "keep"),
    writeFile(path.join(root, "process.lock.stale.notes"), "keep"),
  ]);
  try {
    await purgeLocalState(paths, { masterKeyStore: new MemoryMasterKeyStore() });
    await assert.rejects(access(paths.configFile));
    await assert.rejects(access(paths.auditFile));
    await assert.rejects(access(paths.brokerFile));
    await access(path.join(paths.outboxDir, "keep.txt"));
    await access(paths.ownershipMarker);
    await assert.rejects(access(path.join(root, ".config.json.1.33333333-3333-4333-8333-333333333333.tmp")));
    await assert.rejects(access(path.join(root, "audit.log.1.11111111-1111-4111-8111-111111111111.tmp")));
    await assert.rejects(access(path.join(root, "process.lock.candidate.44444444-4444-4444-8444-444444444444")));
    await assert.rejects(access(path.join(root, ".broker.json.1.55555555-5555-4555-8555-555555555555.tmp")));
    await assert.rejects(access(path.join(root, "broker-launch.lock.candidate.66666666-6666-4666-8666-666666666666")));
    await assert.rejects(access(path.join(root, "broker-launch.lock.reclaim.stale.77777777-7777-4777-8777-777777777777")));
    await access(path.join(root, "audit.log.notes.tmp"));
    await access(path.join(root, ".config.json.notes.tmp"));
    await access(path.join(root, "process.lock.stale.notes"));
    await access(path.join(root, "process.lock.candidate.crash"));
    await access(path.join(root, ".config.json.1.crash.tmp"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purge refuses a state root that lacks the package ownership marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-unowned-purge-"));
  const paths = new StatePaths(root);
  await writeFile(paths.configFile, "do not delete");
  try {
    await assert.rejects(
      purgeLocalState(paths, { masterKeyStore: new MemoryMasterKeyStore() }),
      (error) => error.code === "unowned_state_directory",
    );
    assert.equal(await readFile(paths.configFile, "utf8"), "do not delete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core close still closes SQLite and releases the lock when disconnect fails", async () => {
  const calls = [];
  const core = new WhatsAppCore(
    { close: () => calls.push("state") },
    { close: async () => calls.push("auth") }, {}, {},
    { disconnect: async () => { calls.push("disconnect"); throw new Error("close failed"); } },
    { release: async () => calls.push("lock") },
  );
  await assert.rejects(core.close(), /close failed/);
  assert.deepEqual(calls, ["disconnect", "auth", "state", "lock"]);
});
