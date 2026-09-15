// Agent context note: Verifies the publish tarball, canonical safewhatsapp CLI, safe setup/pairing boundaries, exact MCP tool surface, and shared-broker lifecycle across supported npm platforms. Tests: this script in CI. Critical invariant: child processes invoke reviewed JS entrypoints without a shell while the generated npm command shim is separately validated; no local WhatsApp state or undeclared tool ships. Update this note after meaningful package-contract changes.
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandTimeoutMs = 180_000;
const mcpTimeoutMs = 15_000;

function run(command, args, options = {}) {
  return execFile(command, args, {
    timeout: commandTimeoutMs,
    ...options,
  });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !path.isAbsolute(npmCli)) {
    throw new Error("Run the package smoke through `npm run smoke:pack`.");
  }
  return run(process.execPath, [npmCli, ...args], options);
}

async function withTimeout(promise, label, timeoutMs = mcpTimeoutMs) {
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

function assertSafePackage(files) {
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "npm-shrinkwrap.json",
    "dist/cli.js",
  ];
  for (const expected of required) {
    if (!files.includes(expected)) {
      throw new Error(`Package is missing required file: ${expected}`);
    }
  }

  const allowedFiles = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "npm-shrinkwrap.json",
    "examples/codex-config.toml",
    "examples/config.example.json",
    "examples/stdio-client.example.json",
  ]);
  const outsideAllowlist = files.find(
    (entry) =>
      !allowedFiles.has(entry) &&
      !entry.startsWith("dist/"),
  );
  if (outsideAllowlist) {
    throw new Error(`Package contains a path outside its allowlist: ${outsideAllowlist}`);
  }

  const forbidden = files.find((entry) => {
    const normalized = entry.toLowerCase();
    return (
      normalized === ".env" ||
      normalized.startsWith(".env.") ||
      normalized.startsWith("src/") ||
      normalized.startsWith("test/") ||
      normalized.startsWith("node_modules/") ||
      normalized.includes(".safe-whatsapp-mcp/") ||
      normalized.includes("state.sqlite") ||
      normalized === "config.json" ||
      normalized === "auth" ||
      normalized.startsWith("auth/") ||
      normalized === "pending" ||
      normalized.startsWith("pending/") ||
      normalized === "outbox" ||
      normalized.startsWith("outbox/") ||
      normalized === "media" ||
      normalized.startsWith("media/") ||
      normalized.endsWith(".log")
    );
  });
  if (forbidden) {
    throw new Error(`Package unexpectedly includes private/local data: ${forbidden}`);
  }
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "safe-whatsapp-mcp-smoke-"));
const npmEnv = {
  ...process.env,
  npm_config_cache: path.join(tmp, ".npm-cache"),
};

const sourcePackage = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
if (sourcePackage.scripts?.postinstall) {
  throw new Error("Package must not define a postinstall script");
}

const { stdout } = await runNpm(
  ["pack", "--json", "--silent", "--pack-destination", tmp],
  { cwd: projectRoot, env: npmEnv },
);
const [pack] = JSON.parse(stdout);
const includedPaths = pack.files.map((file) => file.path);
assertSafePackage(includedPaths);
await assertNoStaleBuild(includedPaths);

const tarball = path.join(tmp, pack.filename);
const globalPrefix = path.join(tmp, "global");
await Promise.all((process.platform === "win32"
  ? [path.join(globalPrefix, "node_modules")]
  : [path.join(globalPrefix, "bin"), path.join(globalPrefix, "lib", "node_modules")])
  .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
await runNpm(
  ["install", "--global", "--prefix", globalPrefix, "--no-audit", "--no-fund", tarball],
  { cwd: tmp, env: npmEnv },
);

const installRoot = process.platform === "win32"
  ? path.join(globalPrefix, "node_modules", "safe-whatsapp-mcp")
  : path.join(globalPrefix, "lib", "node_modules", "safe-whatsapp-mcp");
const installedPackage = JSON.parse(
  await readFile(path.join(installRoot, "package.json"), "utf8"),
);
if (installedPackage.version !== sourcePackage.version) {
  throw new Error("Installed package version differs from the source package");
}
if (installedPackage.scripts?.postinstall) {
  throw new Error("Installed package unexpectedly defines a postinstall script");
}
if (installedPackage.bin?.safewhatsapp !== "dist/cli.js") {
  throw new Error("Installed package does not expose the canonical safewhatsapp entrypoint");
}

const bin = path.join(
  globalPrefix,
  ...(process.platform === "win32"
    ? ["safewhatsapp.cmd"]
    : ["bin", "safewhatsapp"]),
);
const cliEntry = path.join(installRoot, installedPackage.bin.safewhatsapp);
await Promise.all([access(bin), access(cliEntry)]);
const shimHelp = await runInstalledShim(bin, ["--help"], { cwd: tmp });
if (!shimHelp.stdout.includes("safewhatsapp") || !shimHelp.stdout.includes("setup-codex")) {
  throw new Error("Globally installed safewhatsapp command did not run");
}
const runInstalledCli = (args) => run(process.execPath, [cliEntry, ...args], { cwd: tmp });
const help = await runInstalledCli(["--help"]);
if (!help.stdout.includes("safewhatsapp") || !help.stdout.includes("serve") ||
    !help.stdout.includes("setup-codex")) {
  throw new Error("Installed CLI help does not describe the serve command");
}

const installedRequire = createRequire(path.join(installRoot, "package.json"));
const keyringEntry = installedRequire.resolve("@napi-rs/keyring");
const keyring = await import(pathToFileURL(keyringEntry).href);
if (!keyring || typeof keyring !== "object") {
  throw new Error("Installed native credential-store dependency did not load");
}

const selfExecutableUrl = pathToFileURL(
  path.join(installRoot, "dist", "codex", "selfExecutable.js"),
).href;
const { resolveInstalledMcpLaunch } = await import(selfExecutableUrl);
const installedLaunch = await resolveInstalledMcpLaunch();
if (installedLaunch.command !== await realpath(process.execPath) ||
    installedLaunch.args[0] !== await realpath(cliEntry) ||
    installedLaunch.args[1] !== "serve") {
  throw new Error("Installed package did not resolve a stable Codex MCP launch");
}

try {
  await runInstalledCli(["connect"]);
  throw new Error("Non-interactive packaged connect unexpectedly succeeded");
} catch (error) {
  if (!error?.stderr?.includes("interactive local terminal")) throw error;
  if (error.stdout?.includes("qr.png")) throw new Error("Packaged connect exposed QR output");
}

const expectedTools = [
  "fetch_older_whatsapp_messages",
  "get_whatsapp_status",
  "list_whatsapp_chats",
  "read_whatsapp_chat",
  "search_whatsapp_messages",
];
const stateDir = path.join(tmp, "smoke-state");
const mcpEnv = {
  ...process.env,
  SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
  SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
  SAFE_WHATSAPP_MCP_STATE_DIR: stateDir,
};
const first = mcpChild("first", mcpEnv);
const second = mcpChild("second", mcpEnv);
let brokerPid;

try {
  await Promise.all([
    withTimeout(first.client.connect(first.transport), "first MCP connect"),
    withTimeout(second.client.connect(second.transport), "second MCP connect"),
  ]);

  const [firstTools, secondTools, descriptor, lock] = await Promise.all([
    withTimeout(first.client.listTools(), "first MCP listTools"),
    withTimeout(second.client.listTools(), "second MCP listTools"),
    readJsonWhenPresent(path.join(stateDir, "broker.json")),
    readJsonWhenPresent(path.join(stateDir, "process.lock")),
  ]);
  assertExactTools(firstTools, "first");
  assertExactTools(secondTools, "second");
  brokerPid = descriptor.pid;
  if (!Number.isSafeInteger(brokerPid) || lock.pid !== brokerPid) {
    throw new Error("Installed MCP clients did not share one broker process");
  }

  const [firstStatus, secondStatus] = await Promise.all([
    getStatus(first.client, "first"),
    getStatus(second.client, "second"),
  ]);
  assertOfflineStatus(firstStatus, "first");
  assertOfflineStatus(secondStatus, "second");
  if (JSON.stringify(firstStatus.structuredContent) !==
      JSON.stringify(secondStatus.structuredContent)) {
    throw new Error("Concurrent installed MCP clients returned different status data");
  }

  await closeMcpChild(first);
  assertOfflineStatus(await getStatus(second.client, "surviving second"), "surviving second");
  await closeMcpChild(second);
  await waitForMissing([
    path.join(stateDir, "broker.json"),
    path.join(stateDir, "process.lock"),
  ]);
} catch (error) {
  if (error instanceof Error) {
    error.message += `\nfirst stderr: ${first.stderr.trim()}\nsecond stderr: ${second.stderr.trim()}`;
  }
  throw error;
} finally {
  await Promise.all([closeMcpChild(first), closeMcpChild(second)]);
  await stopSmokeBroker(brokerPid, stateDir);
}

console.log(`Smoke package OK: ${pack.filename}`);

async function assertNoStaleBuild(files) {
  for (const entry of files) {
    if (!entry.startsWith("dist/") || (!entry.endsWith(".js") && !entry.endsWith(".d.ts"))) {
      continue;
    }
    const source = entry
      .slice("dist/".length)
      .replace(/(?:\.d)?\.js$/u, ".ts")
      .replace(/\.d\.ts$/u, ".ts");
    try {
      await access(path.join(projectRoot, "src", source));
    } catch {
      throw new Error(`Package contains stale compiled output: ${entry}`);
    }
  }
}

function mcpChild(name, env) {
  const transport = new StdioClientTransport({
    command: installedLaunch.command,
    args: installedLaunch.args,
    env,
    stderr: "pipe",
  });
  const child = {
    client: new Client({ name: `safe-whatsapp-mcp-smoke-${name}`, version: "0.0.0" }),
    transport,
    stderr: "",
    closed: false,
  };
  transport.stderr?.on("data", (chunk) => { child.stderr += chunk.toString(); });
  return child;
}

async function runInstalledShim(command, args, options) {
  if (process.platform !== "win32") return run(command, args, options);
  const commandShell = process.env.ComSpec;
  if (!commandShell || !path.isAbsolute(commandShell)) {
    throw new Error("Windows package smoke requires an absolute ComSpec");
  }
  const quoted = [command, ...args]
    .map((value) => `"${value.replaceAll('"', '""')}"`)
    .join(" ");
  return run(commandShell, ["/d", "/s", "/c", quoted], options);
}

async function closeMcpChild(child) {
  if (child.closed) return;
  child.closed = true;
  await withTimeout(child.client.close(), "MCP client close").catch(() => undefined);
  await withTimeout(child.transport.close(), "MCP transport close").catch(() => undefined);
}

async function getStatus(client, label) {
  return withTimeout(
    client.callTool({ name: "get_whatsapp_status", arguments: {} }),
    `${label} get_whatsapp_status`,
  );
}

function assertExactTools(response, label) {
  const actual = response.tools.map((tool) => tool.name).sort();
  if (response.tools.length !== expectedTools.length ||
      JSON.stringify(actual) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected ${label} MCP tools: ${actual.join(", ")}`);
  }
}

function assertOfflineStatus(result, label) {
  const status = result.structuredContent;
  if (
    result.isError !== undefined ||
    status?.ok !== true ||
    status.data?.paired !== false ||
    status.data?.connected !== false ||
    status.data?.sendEnabled !== false ||
    status.data?.mediaSendEnabled !== false
  ) {
    throw new Error(`Unexpected ${label} MCP status: ${JSON.stringify(status)}`);
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

async function stopSmokeBroker(pid, stateDir) {
  const [descriptor, lock] = await Promise.all([
    readJsonIfPresent(path.join(stateDir, "broker.json")),
    readJsonIfPresent(path.join(stateDir, "process.lock")),
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
    path.join(stateDir, "broker.json"),
    path.join(stateDir, "process.lock"),
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
