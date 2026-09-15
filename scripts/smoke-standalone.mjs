// Agent context note: Extracts the standalone archive into a clean temporary directory, then proves its launcher, native modules, and broker-backed MCP work without node on PATH. Tests: run via npm run smoke:standalone after build:standalone. Never use a real WhatsApp profile, Codex config, or credential store entry; update this note after meaningful changes.
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertStandalonePlatform,
  standaloneBundleName,
  standaloneExecutableName,
} from "./standalone-layout.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
assertStandalonePlatform(process.platform);
const bundleName = standaloneBundleName(packageJson.version, process.platform, process.arch);
const archive = path.join(projectRoot, "release", `${bundleName}.tar.gz`);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "safewhatsapp-standalone-smoke-"));
const extractionRoot = path.join(temporaryRoot, "extracted");
const bundleRoot = path.join(extractionRoot, bundleName);
const launcher = path.join(bundleRoot, standaloneExecutableName(process.platform));
const expectedTools = [
  "fetch_older_whatsapp_messages",
  "get_whatsapp_status",
  "list_whatsapp_chats",
  "read_whatsapp_chat",
  "search_whatsapp_messages",
];

try {
  await mkdir(extractionRoot, { mode: 0o700 });
  const tar = await firstExisting(["/usr/bin/tar", "/bin/tar"], "tar");
  await access(archive);
  await execFile(tar, ["-xzf", archive, "-C", extractionRoot], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
  });
  const extractedEntries = await readdir(extractionRoot);
  if (extractedEntries.length !== 1 || extractedEntries[0] !== bundleName) {
    throw new Error("Standalone archive must contain exactly its target bundle directory.");
  }
  await access(launcher);
  await assertBundleContainsNoLocalState(bundleRoot);
  const isolatedPath = path.join(temporaryRoot, "isolated-path");
  await mkdir(isolatedPath, { mode: 0o700 });
  const readlink = await firstExisting(["/usr/bin/readlink", "/bin/readlink"], "readlink");
  await symlink(readlink, path.join(isolatedPath, "readlink"));
  const state = path.join(temporaryRoot, "state");
  const env = {
    ...process.env,
    CODEX_HOME: path.join(temporaryRoot, "codex-home"),
    PATH: isolatedPath,
    SAFE_WHATSAPP_MCP_STATE_DIR: state,
    SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
    SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
    SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
  };
  for (const inheritedLoaderVariable of [
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "LD_LIBRARY_PATH",
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    delete env[inheritedLoaderVariable];
  }

  const version = await runLauncher(launcher, ["--version"], env);
  if (version.stdout.trim() !== packageJson.version) throw new Error("Standalone version mismatch.");
  const linkedLauncher = path.join(temporaryRoot, "safewhatsapp");
  await symlink(launcher, linkedLauncher);
  const linkedVersion = await runLauncher(linkedLauncher, ["--version"], env);
  if (linkedVersion.stdout.trim() !== packageJson.version) {
    throw new Error("Symlinked standalone launcher version mismatch.");
  }
  const help = await runLauncher(launcher, ["--help"], env);
  if (!help.stdout.startsWith(`safewhatsapp ${packageJson.version}\n`)) {
    throw new Error("Standalone help does not expose the canonical command.");
  }
  if (!help.stdout.includes("setup-codex") || !help.stdout.includes("disconnect")) {
    throw new Error("Standalone help is missing the onboarding commands.");
  }
  try {
    await runLauncher(launcher, ["setup-codex"], env);
    throw new Error("Standalone setup unexpectedly found Codex on the isolated PATH.");
  } catch (error) {
    if (!error?.stderr?.includes("codex_cli_not_found")) throw error;
    if (error.stderr.includes("dist/cli.js") || error.stderr.includes("runtime/bin/node")) {
      throw new Error("Standalone setup exposed an internal runtime path.");
    }
  }
  const status = await runLauncher(launcher, ["status"], env);
  const parsed = JSON.parse(status.stdout);
  if (parsed.paired !== false || parsed.connected !== false) {
    throw new Error("Standalone smoke profile was unexpectedly connected.");
  }
  await assertBrokerBackedMcp(launcher, env, state);
  await importBundledNativeModule("@napi-rs/keyring/index.js", env);
  await importBundledNativeModule("sharp/dist/index.mjs", env);
  try {
    await runLauncher(launcher, ["connect"], env);
    throw new Error("Non-interactive standalone connect unexpectedly succeeded");
  } catch (error) {
    if (!error?.stderr?.includes("interactive local terminal")) throw error;
    if (error.stdout?.includes("qr.png")) throw new Error("Standalone connect exposed QR output");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`Standalone archive smoke OK without node on PATH: ${path.basename(archive)}\n`);

function runLauncher(command, args, env) {
  return execFile(command, args, { cwd: bundleRoot, env, timeout: 30_000 });
}

async function assertBrokerBackedMcp(command, env, state) {
  const transport = new StdioClientTransport({
    command,
    args: ["serve"],
    cwd: bundleRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "safe-whatsapp-standalone-smoke", version: "0.0.0" });
  let brokerPid;
  let stderr = "";
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await withTimeout(client.close(), "standalone MCP client close").catch(() => undefined);
    await withTimeout(transport.close(), "standalone MCP transport close").catch(() => undefined);
  };
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await withTimeout(client.connect(transport), "standalone MCP connect");
    const [tools, descriptor, lock] = await Promise.all([
      withTimeout(client.listTools(), "standalone MCP listTools"),
      readJsonWhenPresent(path.join(state, "broker.json")),
      readJsonWhenPresent(path.join(state, "process.lock")),
    ]);
    brokerPid = descriptor.pid;
    if (!Number.isSafeInteger(brokerPid) || lock.pid !== brokerPid) {
      throw new Error("Standalone MCP did not start one broker-owned state process.");
    }
    const actualTools = tools.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
      throw new Error(`Unexpected standalone MCP tools: ${actualTools.join(", ")}`);
    }

    const result = await withTimeout(
      client.callTool({ name: "get_whatsapp_status", arguments: {} }),
      "standalone get_whatsapp_status",
    );
    const status = result.structuredContent;
    if (
      result.isError !== undefined ||
      status?.ok !== true ||
      status.data?.paired !== false ||
      status.data?.connected !== false ||
      status.data?.sendEnabled !== false ||
      status.data?.mediaSendEnabled !== false
    ) {
      throw new Error(`Unexpected standalone MCP status: ${JSON.stringify(status)}`);
    }

    await close();
    await waitForMissing([
      path.join(state, "broker.json"),
      path.join(state, "process.lock"),
    ]);
  } catch (error) {
    if (error instanceof Error) error.message += `\nstandalone MCP stderr: ${stderr.trim()}`;
    throw error;
  } finally {
    await close();
    await stopSmokeBroker(brokerPid, state);
  }
}

async function withTimeout(promise, label, timeoutMs = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonWhenPresent(filePath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
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
        await access(filePath);
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

async function stopSmokeBroker(pid, state) {
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
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function importBundledNativeModule(relativePath, env) {
  const runtime = path.join(
    bundleRoot,
    "runtime",
    "bin/node",
  );
  const moduleUrl = pathToFileURL(path.join(bundleRoot, "app/node_modules", relativePath)).href;
  return execFile(runtime, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)})`,
  ], { cwd: bundleRoot, env, timeout: 30_000 });
}

async function firstExisting(candidates, name) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard system path.
    }
  }
  throw new Error(`The standalone smoke test could not find ${name}.`);
}

async function assertBundleContainsNoLocalState(root) {
  const entries = (await readdir(root, { recursive: true })).map((entry) =>
    entry.replaceAll(path.sep, "/").toLowerCase()
  );
  const forbidden = entries.find((entry) => {
    const segments = entry.split("/");
    const leaf = segments.at(-1) ?? "";
    return leaf === ".env" ||
      leaf.startsWith(".env.") ||
      segments.includes(".safe-whatsapp-mcp") ||
      leaf === ".safe-whatsapp-mcp-state" ||
      leaf === "credential-vault.json" ||
      /^state\.sqlite3(?:-|$)/u.test(leaf) ||
      leaf === "audit.log" ||
      /(^|\/)app\/(pending|media|outbox)(\/|$)/u.test(entry);
  });
  if (forbidden) throw new Error(`Standalone bundle contains local state: ${forbidden}`);
}
