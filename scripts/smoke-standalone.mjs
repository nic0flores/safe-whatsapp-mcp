// Agent context note: Proves the standalone launcher can load SQLite/Keychain code, validate its own setup identity, and run the CLI without any node executable on PATH. Tests: run via npm run smoke:standalone after build:standalone. Never use a real WhatsApp profile, Codex config, or credential store entry; update this note after meaningful changes.
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const bundleRoot = path.join(projectRoot, "release", bundleName);
const launcher = path.join(bundleRoot, standaloneExecutableName(process.platform));
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "safewhatsapp-standalone-smoke-"));

try {
  await access(launcher);
  await assertBundleContainsNoLocalState(bundleRoot);
  const isolatedPath = path.join(temporaryRoot, "isolated-path");
  await mkdir(isolatedPath, { mode: 0o700 });
  const readlink = await firstExisting(["/usr/bin/readlink", "/bin/readlink"]);
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
  await importBundledNativeModule("@napi-rs/keyring/index.js", env);
  await importBundledNativeModule("sharp/dist/index.mjs", env);
  try {
    await runLauncher(launcher, ["connect"], env);
    throw new Error("Non-interactive standalone connect unexpectedly succeeded.");
  } catch (error) {
    if (!error?.stderr?.includes("interactive local terminal")) throw error;
    if (error.stdout?.includes("qr.png")) throw new Error("Standalone connect exposed QR output.");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`Standalone smoke OK without node on PATH: ${bundleName}\n`);

function runLauncher(command, args, env) {
  return execFile(command, args, { cwd: bundleRoot, env, timeout: 30_000 });
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

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard system path.
    }
  }
  throw new Error("The standalone smoke test could not find readlink.");
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
