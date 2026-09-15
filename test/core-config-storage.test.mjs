import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigLoader, DEFAULT_LOCAL_CONFIG, validateConfig } from "../dist/config/config.js";
import { StatePaths } from "../dist/storage/paths.js";
import { writePrivateJson } from "../dist/storage/privateFiles.js";
import { temporaryState } from "./core-helpers.mjs";
import { SqliteState } from "../dist/storage/database.js";

test("config resolves hardened defaults and environment flags cannot enable sends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-config-"));
  const paths = new StatePaths(root);
  const oldSend = process.env.SAFE_WHATSAPP_MCP_ENABLE_SEND;
  const oldMedia = process.env.SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND;
  try {
    process.env.SAFE_WHATSAPP_MCP_ENABLE_SEND = "true";
    process.env.SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND = "true";
    const config = await new ConfigLoader(paths).load();
    assert.equal(config.retentionMs, 3 * 86_400_000);
    assert.equal(config.maxMessagesPerChat, 100);
    assert.equal(config.pendingTtlMs, 10 * 60_000);
    assert.equal(config.syncTimeoutMs, 15_000);
    assert.equal(config.idleTimeoutMs, 60_000);
    assert.equal(config.inlineMediaBytes, 8 * 1_048_576);
    assert.equal(config.maxMediaBytes, 25 * 1_048_576);
    assert.equal(config.sendEnabled, false);
    assert.equal(config.mediaSendEnabled, false);
    assert.equal(DEFAULT_LOCAL_CONFIG.retentionDays, 3);
    assert.equal(DEFAULT_LOCAL_CONFIG.maxMessagesPerChat, 100);
  } finally {
    if (oldSend === undefined) delete process.env.SAFE_WHATSAPP_MCP_ENABLE_SEND;
    else process.env.SAFE_WHATSAPP_MCP_ENABLE_SEND = oldSend;
    if (oldMedia === undefined) delete process.env.SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND;
    else process.env.SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND = oldMedia;
  }
});

test("config rejects invalid ranges and inline media above maximum", async () => {
  assert.throws(() => validateConfig({ retentionDay: 7 }), /unsupported setting/);
  assert.throws(() => validateConfig({ maxMessagesPerChat: 1.5 }), /positive integer/);
  assert.throws(() => validateConfig({ retentionDays: 0 }), /positive number/);
  assert.throws(() => validateConfig({ inlineMediaMiB: 9 }), /cannot exceed 8/);
  assert.throws(() => validateConfig({ maxMediaMiB: 26 }), /cannot exceed 25/);
  assert.throws(() => validateConfig({ maxMessagesPerChat: 10_001 }), /cannot exceed 10000/);
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-config-"));
  const paths = new StatePaths(root);
  await writePrivateJson(paths.configFile, { inlineMediaMiB: 26, maxMediaMiB: 25 });
  await assert.rejects(new ConfigLoader(paths).load(), /cannot exceed/);
  await rm(root, { recursive: true, force: true });
});

test("private state uses 0700 directories and 0600 files", { skip: process.platform === "win32" }, async () => {
  const fixture = await temporaryState();
  try {
    await writePrivateJson(fixture.paths.configFile, { retentionDays: 2 });
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    assert.equal((await stat(fixture.paths.configFile)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.paths.databaseFile)).mode & 0o777, 0o600);
    assert.deepEqual(fixture.state.counts(), { chats: 0, messages: 0, identities: 0 });
  } finally {
    await fixture.cleanup();
  }
});

test("config and database files refuse symbolic-link targets", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-symlink-"));
  const outside = path.join(root, "outside");
  const stateRoot = path.join(root, "state");
  const paths = new StatePaths(stateRoot);
  try {
    await writeFile(outside, "{}", { mode: 0o600 });
    await mkdir(stateRoot, { mode: 0o700 });
    await symlink(outside, paths.configFile);
    await assert.rejects(new ConfigLoader(paths).load(), (error) => error.code === "unsafe_state_path");
    await unlink(paths.configFile);
    await symlink(outside, paths.databaseFile);
    await assert.rejects(SqliteState.open(paths), (error) => error.code === "unsafe_state_path");
    await unlink(paths.databaseFile);
    await symlink(outside, `${paths.databaseFile}-journal`);
    await assert.rejects(SqliteState.open(paths), (error) => error.code === "unsafe_state_path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
