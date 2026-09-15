import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withBrokerStateTakeover } from "../dist/broker/exclusive.js";
import { ProcessLock } from "../dist/storage/processLock.js";
import { StatePaths } from "../dist/storage/paths.js";

const cli = path.resolve("dist/cli.js");
const execFile = promisify(execFileCallback);
const expectedTools = [
  "fetch_older_whatsapp_messages",
  "get_whatsapp_status",
  "list_whatsapp_chats",
  "read_whatsapp_chat",
  "search_whatsapp_messages",
];

test("two STDIO clients share one broker until the last client closes", { timeout: 30_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-broker-"));
  const state = path.join(temporary, "state");
  const env = {
    ...process.env,
    SAFE_WHATSAPP_MCP_STATE_DIR: state,
    SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
    SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
  };
  const first = mcpChild("first", env);
  const second = mcpChild("second", env);
  let brokerPid;

  try {
    await Promise.all([
      withTimeout(first.client.connect(first.transport), "first MCP connect"),
      withTimeout(second.client.connect(second.transport), "second MCP connect"),
    ]);

    const firstProxyPid = first.transport.pid;
    const secondProxyPid = second.transport.pid;
    assert.ok(Number.isSafeInteger(firstProxyPid));
    assert.ok(Number.isSafeInteger(secondProxyPid));
    assert.notEqual(firstProxyPid, secondProxyPid);

    const [firstTools, secondTools, descriptor, lock] = await Promise.all([
      withTimeout(first.client.listTools(), "first listTools"),
      withTimeout(second.client.listTools(), "second listTools"),
      readJsonWhenPresent(path.join(state, "broker.json")),
      readJsonWhenPresent(path.join(state, "process.lock")),
    ]);
    assert.deepEqual(toolNames(firstTools), expectedTools);
    assert.deepEqual(toolNames(secondTools), expectedTools);
    assert.equal(firstTools.tools.length, 5);
    assert.equal(secondTools.tools.length, 5);

    brokerPid = descriptor.pid;
    assert.ok(Number.isSafeInteger(brokerPid));
    assert.equal(lock.pid, brokerPid);
    assert.notEqual(brokerPid, firstProxyPid);
    assert.notEqual(brokerPid, secondProxyPid);

    const [firstStatus, secondStatus] = await Promise.all([
      getStatus(first.client),
      getStatus(second.client),
    ]);
    assertOffline(firstStatus);
    assertOffline(secondStatus);

    const cliStatus = await execFile(process.execPath, [cli, "status"], {
      env: { ...env, SAFE_WHATSAPP_MCP_ENABLE_SEND: "true" },
    });
    assert.equal(JSON.parse(cliStatus.stdout).paired, false);
    assert.equal((await readJsonWhenPresent(path.join(state, "process.lock"))).pid, brokerPid);
    assertOffline(await getStatus(first.client));
    assertOffline(await getStatus(second.client));

    await closeMcpChild(first);
    const survivingStatus = await getStatus(second.client);
    assertOffline(survivingStatus);
    assert.equal((await readJsonWhenPresent(path.join(state, "process.lock"))).pid, brokerPid);

    await closeMcpChild(second);
    await waitForMissing([
      path.join(state, "broker.json"),
      path.join(state, "process.lock"),
    ]);
  } catch (error) {
    if (error instanceof Error) {
      error.message += `\nfirst stderr: ${first.stderr.trim()}\nsecond stderr: ${second.stderr.trim()}`;
    }
    throw error;
  } finally {
    await Promise.all([closeMcpChild(first), closeMcpChild(second)]);
    await stopTestBroker(brokerPid, state);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("an exclusive CLI handoff drains shared clients before direct state access", { timeout: 30_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-takeover-"));
  const state = path.join(temporary, "state");
  const env = {
    ...process.env,
    SAFE_WHATSAPP_MCP_STATE_DIR: state,
    SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
    SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
  };
  const first = mcpChild("takeover-first", env);
  const second = mcpChild("takeover-second", env);
  let third;
  let brokerPid;

  try {
    await Promise.all([
      withTimeout(first.client.connect(first.transport), "first takeover MCP connect"),
      withTimeout(second.client.connect(second.transport), "second takeover MCP connect"),
    ]);
    brokerPid = (await readJsonWhenPresent(path.join(state, "broker.json"))).pid;
    const paths = new StatePaths(state);

    await withBrokerStateTakeover(paths, async () => {
      await waitForMissing([paths.brokerFile, paths.lockFile]);
      const directLock = new ProcessLock(paths.lockFile);
      await directLock.acquire();
      await directLock.release();
    });

    third = mcpChild("takeover-third", env);
    await withTimeout(third.client.connect(third.transport), "replacement MCP connect");
    assertOffline(await getStatus(third.client));
    const replacement = await readJsonWhenPresent(path.join(state, "broker.json"));
    assert.notEqual(replacement.pid, brokerPid);

    await closeMcpChild(third);
    await waitForMissing([paths.brokerFile, paths.lockFile]);
  } catch (error) {
    if (error instanceof Error) {
      error.message += `\nfirst stderr: ${first.stderr.trim()}\nsecond stderr: ${second.stderr.trim()}` +
        `\nthird stderr: ${third?.stderr.trim() ?? ""}`;
    }
    throw error;
  } finally {
    await Promise.all([
      closeMcpChild(first),
      closeMcpChild(second),
      ...(third ? [closeMcpChild(third)] : []),
    ]);
    await stopTestBroker(undefined, state);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function mcpChild(name, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve"],
    env,
    stderr: "pipe",
  });
  const result = {
    client: new Client({ name: `safe-whatsapp-broker-${name}`, version: "0.0.0" }),
    transport,
    stderr: "",
    closed: false,
  };
  transport.stderr?.on("data", (chunk) => { result.stderr += chunk.toString(); });
  return result;
}

async function closeMcpChild(child) {
  if (child.closed) return;
  child.closed = true;
  await withTimeout(child.client.close(), "MCP client close").catch(() => undefined);
  await withTimeout(child.transport.close(), "MCP transport close").catch(() => undefined);
}

async function getStatus(client) {
  return withTimeout(
    client.callTool({ name: "get_whatsapp_status", arguments: {} }),
    "get_whatsapp_status",
  );
}

function assertOffline(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.paired, false);
  assert.equal(result.structuredContent.data.connected, false);
}

function toolNames(response) {
  return response.tools.map((tool) => tool.name).sort();
}

async function readJsonWhenPresent(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

async function waitForMissing(filePaths, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await Promise.all(filePaths.map(async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }));
    if (present.every((value) => !value)) return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for broker files to disappear: ${filePaths.join(", ")}`);
}

async function stopTestBroker(pid, state) {
  const [descriptor, lock] = await Promise.all([
    readJsonIfPresent(path.join(state, "broker.json")),
    readJsonIfPresent(path.join(state, "process.lock")),
  ]);
  if (
    !descriptor ||
    !lock ||
    !Number.isSafeInteger(descriptor.pid) ||
    descriptor.pid !== lock.pid ||
    (Number.isSafeInteger(pid) && descriptor.pid !== pid)
  ) return;
  try {
    process.kill(descriptor.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await waitForMissing([
    path.join(state, "broker.json"),
    path.join(state, "process.lock"),
  ], 3_000).catch(() => undefined);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function withTimeout(promise, label, timeoutMs = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
