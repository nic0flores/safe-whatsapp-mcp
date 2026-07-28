// Agent context note: Verifies the publish tarball, canonical safewhatsapp CLI, safe setup/pairing boundaries, and exact MCP tool surface across supported npm platforms. Tests: this script in CI. Critical invariant: child processes invoke reviewed JS entrypoints without a shell while the generated npm command shim is separately validated; no local WhatsApp state or undeclared tool ships. Update this note after meaningful package-contract changes.
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
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
  ]);
  const outsideAllowlist = files.find(
    (entry) =>
      !allowedFiles.has(entry) &&
      !entry.startsWith("dist/") &&
      !entry.startsWith("examples/"),
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
await runNpm(
  ["install", "--no-audit", "--no-fund", tarball],
  { cwd: tmp, env: npmEnv },
);

const installRoot = path.join(tmp, "node_modules", "safe-whatsapp-mcp");
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
  tmp,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "safewhatsapp.cmd" : "safewhatsapp",
);
const cliEntry = path.join(installRoot, installedPackage.bin.safewhatsapp);
await Promise.all([access(bin), access(cliEntry)]);
const runInstalledCli = (args) => run(process.execPath, [cliEntry, ...args], { cwd: tmp });
const help = await runInstalledCli(["--help"]);
if (!help.stdout.includes("safewhatsapp") || !help.stdout.includes("serve") ||
    !help.stdout.includes("setup-codex")) {
  throw new Error("Installed CLI help does not describe the serve command");
}

try {
  await runInstalledCli(["connect"]);
  throw new Error("Non-interactive packaged connect unexpectedly succeeded");
} catch (error) {
  if (!error?.stderr?.includes("interactive local terminal")) throw error;
  if (error.stdout?.includes("qr.png")) throw new Error("Packaged connect exposed QR output");
}

const client = new Client({ name: "safe-whatsapp-mcp-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliEntry, "serve"],
  env: {
    ...process.env,
    SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
    SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
    SAFE_WHATSAPP_MCP_STATE_DIR: path.join(tmp, "smoke-state"),
  },
});

let tools;
try {
  await withTimeout(client.connect(transport), "MCP connect");
  tools = await withTimeout(client.listTools(), "MCP listTools");
} finally {
  await withTimeout(client.close(), "MCP client close").catch(() => {});
  await withTimeout(transport.close(), "MCP transport close").catch(() => {});
}

const expectedTools = [
  "discard_prepared_whatsapp_message",
  "fetch_older_whatsapp_messages",
  "get_whatsapp_media",
  "get_whatsapp_status",
  "list_whatsapp_chats",
  "list_whatsapp_sends",
  "prepare_whatsapp_media_send",
  "prepare_whatsapp_text_send",
  "read_whatsapp_chat",
  "search_whatsapp_messages",
  "send_prepared_whatsapp_message",
];
const actualTools = tools.tools.map((tool) => tool.name).sort();
if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
  throw new Error(`Unexpected MCP tools: ${actualTools.join(", ")}`);
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
