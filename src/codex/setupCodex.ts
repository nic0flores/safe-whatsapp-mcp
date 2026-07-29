// Agent context note: Safely registers or upgrades a recognized standalone launcher in Codex through its atomic config API. Tests: test/codex-setup.test.mjs. Auto-approve only the non-sending browser opener, preserve the legacy send prompt and unrelated stricter settings, and keep text/media gates explicit.
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  MEDIA_SEND_ENABLED_ENV,
  SEND_ENABLED_ENV,
} from "../constants.js";
import { SafeWhatsAppError } from "../errors.js";
import { WHATSAPP_TOOL_NAMES } from "../mcp/tools.js";
import {
  CodexAppServerConfigClient,
  CodexConfigRpcError,
  type ConfigBatchWriteParams,
} from "./appServerConfig.js";
import {
  isRecognizedStandaloneExecutable,
  resolveStandaloneExecutable,
} from "./selfExecutable.js";

const SERVER_NAME = "safe_whatsapp";
const CONFIG_LIMIT_BYTES = 4 * 1024 * 1024;

interface ConfigClient {
  readConfig(): Promise<unknown>;
  batchWrite(params: ConfigBatchWriteParams): Promise<unknown>;
  close(): Promise<void>;
}

interface ConfigLayer {
  name: { type: string; file?: unknown; profile?: unknown };
  version: string;
  config: Record<string, unknown>;
}

interface ConfigSnapshot {
  exists: boolean;
  dev?: bigint;
  ino?: bigint;
  size?: number;
  mtimeNs?: bigint;
  digest?: string;
}

export interface SetupCodexOptions {
  enableSend?: boolean;
  enableMediaSend?: boolean;
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  createClient?: (codexHome: string, environment: NodeJS.ProcessEnv) => Promise<ConfigClient>;
}

export interface SetupCodexResult {
  changed: boolean;
  configPath: string;
  enabled: boolean;
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
}

export async function setupCodex(options: SetupCodexOptions = {}): Promise<SetupCodexResult> {
  const enableSend = options.enableSend === true;
  const enableMediaSend = options.enableMediaSend === true;
  if (enableMediaSend && !enableSend) {
    throw new SafeWhatsAppError(
      "Media sending requires text sending to be enabled too.",
      "invalid_send_configuration",
    );
  }
  const environment = options.environment ?? process.env;
  const suppliedExecutable = options.executable ?? await resolveStandaloneExecutable({ environment });
  let executable: string;
  try {
    executable = await fs.realpath(suppliedExecutable);
  } catch {
    throw new SafeWhatsAppError(
      "Safe WhatsApp could not verify its installed launcher.",
      "unsafe_standalone_install",
    );
  }
  const codexHome = await prepareCodexHome(environment);
  const configPath = path.join(codexHome, "config.toml");
  await assertSafeConfig(configPath);
  const lock = await acquireSetupLock(path.join(codexHome, ".safe-whatsapp-codex-setup.lock"));
  try {
    const fingerprint = await fingerprintConfig(configPath);
    const createClient = options.createClient ?? ((cwd, env) =>
      CodexAppServerConfigClient.connect({ cwd, environment: env }));
    const codexEnvironment = { ...environment, CODEX_HOME: codexHome };
    const client = await createClient(codexHome, codexEnvironment);
    try {
      const initial = await parseConfigRead(await client.readConfig(), configPath);
      const current = serverAt(initial.user.config);
      const effective = serverAt(initial.effective);
      if (!current && effective) throw registrationConflict();
      if (current) await assertCompatibleServer(current, executable);
      if (enableSend) assertHumanApproval(initial.effective);

      const desired = desiredServer(
        current,
        executable,
        { enableSend, enableMediaSend },
      );
      if (current && containsValue(current, desired) && effective && activeServerMatches(effective, desired)) {
        return result(false, configPath, desired);
      }

      if (current) await assertCompatibleServer(current, executable);
      await assertFingerprint(configPath, fingerprint);
      let writeResult: unknown;
      try {
        writeResult = await client.batchWrite({
          edits: [{
            keyPath: `mcp_servers.${SERVER_NAME}`,
            value: desired,
            mergeStrategy: "upsert",
          }],
          filePath: configPath,
          expectedVersion: initial.user.version,
          reloadUserConfig: false,
        });
      } catch (error) {
        if (error instanceof CodexConfigRpcError &&
            error.dataCode === "configVersionConflict") {
          throw new SafeWhatsAppError(
            "Codex configuration changed during setup. Retry the command.",
            "codex_config_changed",
          );
        }
        throw error;
      }
      await assertWriteResult(writeResult, configPath);
      await assertSafeConfig(configPath);

      const verified = await parseConfigRead(await client.readConfig(), configPath);
      const written = serverAt(verified.user.config);
      const active = serverAt(verified.effective);
      if (!written || !active || !containsValue(written, desired) || !activeServerMatches(active, desired)) {
        throw new SafeWhatsAppError(
          "Codex did not activate the Safe WhatsApp configuration. Review managed configuration and retry.",
          "codex_config_overridden",
        );
      }
      return result(true, configPath, desired);
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await lock.release();
  }
}

function desiredServer(
  current: Record<string, unknown> | undefined,
  executable: string,
  sendPolicy: { enableSend: boolean; enableMediaSend: boolean },
): Record<string, unknown> {
  const enabled = current?.enabled === false ? false : true;
  const defaultApproval = current?.default_tools_approval_mode === "prompt"
    ? "prompt"
    : "writes";
  return {
    command: executable,
    args: ["serve"],
    startup_timeout_sec: 20,
    tool_timeout_sec: 90,
    required: false,
    enabled,
    default_tools_approval_mode: defaultApproval,
    enabled_tools: [...WHATSAPP_TOOL_NAMES],
    env: {
      [SEND_ENABLED_ENV]: sendPolicy.enableSend ? "true" : "false",
      [MEDIA_SEND_ENABLED_ENV]: sendPolicy.enableMediaSend ? "true" : "false",
    },
    tools: {
      open_whatsapp_send_review: { approval_mode: "approve" },
      send_prepared_whatsapp_message: { approval_mode: "prompt" },
    },
  };
}

async function assertCompatibleServer(
  server: Record<string, unknown>,
  executable: string,
): Promise<void> {
  if (typeof server.command !== "string" || !path.isAbsolute(server.command) ||
      !Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== "serve" ||
      server.url !== undefined || server.cwd !== undefined || server.env_vars !== undefined ||
      (server.experimental_environment !== undefined && server.experimental_environment !== "local")) {
    throw registrationConflict();
  }
  let currentRealPath: string;
  try {
    currentRealPath = await fs.realpath(server.command);
  } catch {
    throw registrationConflict();
  }
  if (currentRealPath !== executable &&
      !await isRecognizedStandaloneExecutable(currentRealPath)) {
    throw registrationConflict();
  }
  const env = server.env;
  if (env !== undefined) {
    if (!isRecord(env)) throw registrationConflict();
    const allowed = new Set([SEND_ENABLED_ENV, MEDIA_SEND_ENABLED_ENV]);
    if (Object.keys(env).some((key) => !allowed.has(key))) throw registrationConflict();
  }
}

function assertHumanApproval(config: Record<string, unknown>): void {
  if (config.approval_policy === "never" ||
      (config.approvals_reviewer !== null && config.approvals_reviewer !== undefined &&
        config.approvals_reviewer !== "user")) {
    throw new SafeWhatsAppError(
      "Sending requires Codex approvals to be reviewed by you. Change Codex approval settings or configure without send flags.",
      "human_approval_required",
    );
  }
}

async function parseConfigRead(value: unknown, configPath: string): Promise<{
  effective: Record<string, unknown>;
  user: ConfigLayer;
}> {
  if (!isRecord(value) || !isRecord(value.config) || !Array.isArray(value.layers)) {
    throw configUnavailable();
  }
  let user: ConfigLayer | undefined;
  for (const layer of value.layers) {
    if (!isRecord(layer) || !isRecord(layer.name) || layer.name.type !== "user" ||
        layer.name.profile !== null || typeof layer.name.file !== "string" ||
        typeof layer.version !== "string" || !isRecord(layer.config)) continue;
    if (await sameConfigPath(layer.name.file, configPath)) {
      user = layer as unknown as ConfigLayer;
      break;
    }
  }
  if (!user) throw configUnavailable();
  return { effective: value.config, user };
}

function serverAt(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const servers = config.mcp_servers;
  if (servers === undefined) return undefined;
  if (!isRecord(servers)) throw configUnavailable();
  const server = servers[SERVER_NAME];
  if (server === undefined) return undefined;
  if (!isRecord(server)) throw registrationConflict();
  return server;
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((value, index) => containsValue(actual[index], value));
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected)
      .every(([key, value]) => containsValue(actual[key], value));
  }
  return Object.is(actual, expected) ||
    (typeof actual === "number" && typeof expected === "number" && actual === expected);
}

function activeServerMatches(
  actual: Record<string, unknown>,
  desired: Record<string, unknown>,
): boolean {
  const required = {
    command: desired.command,
    args: desired.args,
    startup_timeout_sec: desired.startup_timeout_sec,
    tool_timeout_sec: desired.tool_timeout_sec,
    default_tools_approval_mode: desired.default_tools_approval_mode,
    enabled_tools: desired.enabled_tools,
    env: desired.env,
    tools: desired.tools,
  };
  return containsValue(actual, required) &&
    (desired.enabled !== false || actual.enabled === false);
}

async function assertWriteResult(value: unknown, configPath: string): Promise<void> {
  if (!isRecord(value) || value.status !== "ok" || typeof value.filePath !== "string" ||
      !await sameConfigPath(value.filePath, configPath) || value.overriddenMetadata !== null) {
    throw new SafeWhatsAppError(
      "A managed Codex setting overrides Safe WhatsApp setup.",
      "codex_config_overridden",
    );
  }
}

async function prepareCodexHome(environment: NodeJS.ProcessEnv): Promise<string> {
  const configured = environment.CODEX_HOME;
  if (configured && !path.isAbsolute(configured)) throw unsafeConfigPath();
  const codexHome = path.resolve(configured || path.join(os.homedir(), ".codex"));
  if (codexHome === path.parse(codexHome).root || codexHome === path.resolve(os.homedir())) {
    throw unsafeConfigPath();
  }
  let info = await fs.lstat(codexHome).catch((error) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    await fs.mkdir(codexHome, { mode: 0o700 });
    info = await fs.lstat(codexHome);
  }
  assertOwned(info, "directory");
  const [canonicalHome, canonicalUserHome] = await Promise.all([
    fs.realpath(codexHome),
    fs.realpath(path.resolve(os.homedir())),
  ]);
  if (canonicalHome === path.parse(canonicalHome).root || canonicalHome === canonicalUserHome) {
    throw unsafeConfigPath();
  }
  return canonicalHome;
}

async function sameConfigPath(left: string, right: string): Promise<boolean> {
  try {
    const [leftParent, rightParent] = await Promise.all([
      fs.realpath(path.dirname(path.resolve(left))),
      fs.realpath(path.dirname(path.resolve(right))),
    ]);
    return path.join(leftParent, path.basename(left)) === path.join(rightParent, path.basename(right));
  } catch {
    return false;
  }
}

async function assertSafeConfig(configPath: string): Promise<void> {
  const info = await fs.lstat(configPath).catch((error) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  assertOwned(info, "file");
  if (info.nlink !== 1 || info.size > CONFIG_LIMIT_BYTES) throw unsafeConfigPath();
}

function assertOwned(info: Awaited<ReturnType<typeof fs.lstat>>, kind: "directory" | "file"): void {
  const expectedKind = kind === "directory" ? info.isDirectory() : info.isFile();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!expectedKind || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) ||
      (Number(info.mode) & 0o022) !== 0) {
    throw unsafeConfigPath();
  }
}

async function fingerprintConfig(configPath: string): Promise<ConfigSnapshot> {
  try {
    const handle = await fs.open(configPath, "r");
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(CONFIG_LIMIT_BYTES)) {
        throw unsafeConfigPath();
      }
      const bytes = await handle.readFile();
      return {
        exists: true,
        dev: info.dev,
        ino: info.ino,
        size: Number(info.size),
        mtimeNs: info.mtimeNs,
        digest: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function assertFingerprint(configPath: string, expected: ConfigSnapshot): Promise<void> {
  const actual = await fingerprintConfig(configPath);
  if (JSON.stringify(actual, (_key, value) => typeof value === "bigint" ? value.toString() : value) !==
      JSON.stringify(expected, (_key, value) => typeof value === "bigint" ? value.toString() : value)) {
    throw new SafeWhatsAppError(
      "Codex configuration changed during setup. Retry the command.",
      "codex_config_changed",
    );
  }
}

async function acquireSetupLock(lockPath: string): Promise<{ release(): Promise<void> }> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${lockPath}.candidate.${token}.${attempt}`;
    try {
      await writeLockCandidate(candidate, token);
      await fs.link(candidate, lockPath);
      await fs.unlink(candidate);
      return {
        release: async () => {
          const current = await readLock(lockPath);
          if (current?.token === token) await fs.unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      await fs.unlink(candidate).catch(() => undefined);
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    const existing = await readLock(lockPath);
    if (existing && isRunning(existing.pid)) {
      throw new SafeWhatsAppError("Safe WhatsApp Codex setup is already running.", "codex_setup_locked");
    }
    if (!existing && !await isRecoverableLock(lockPath)) {
      throw new SafeWhatsAppError("Safe WhatsApp Codex setup is already running.", "codex_setup_locked");
    }
    const stale = `${lockPath}.stale.${randomUUID()}`;
    try {
      await fs.rename(lockPath, stale);
      await fs.unlink(stale);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new SafeWhatsAppError("Safe WhatsApp Codex setup is already running.", "codex_setup_locked");
}

async function writeLockCandidate(candidate: string, token: string): Promise<void> {
  const handle = await fs.open(candidate, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ producer: SERVER_NAME, pid: process.pid, token })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isRecoverableLock(lockPath: string): Promise<boolean> {
  try {
    const info = await fs.lstat(lockPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return info.isFile() && !info.isSymbolicLink() &&
      (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0 &&
      info.size <= 4 * 1024 && Date.now() - info.mtimeMs >= 5_000;
  } catch {
    return false;
  }
}

async function readLock(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
  try {
    const info = await fs.lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 2 ||
        (info.mode & 0o077) !== 0) return undefined;
    const value = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
    return value.producer === SERVER_NAME && Number.isSafeInteger(value.pid) &&
      typeof value.token === "string"
      ? { pid: value.pid as number, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function result(changed: boolean, configPath: string, server: Record<string, unknown>): SetupCodexResult {
  const env = server.env as Record<string, unknown>;
  const sendEnabled = env[SEND_ENABLED_ENV] === "true";
  return {
    changed,
    configPath,
    enabled: server.enabled !== false,
    sendEnabled,
    mediaSendEnabled: sendEnabled && env[MEDIA_SEND_ENABLED_ENV] === "true",
  };
}

function registrationConflict(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Codex already uses the safe_whatsapp name for a different or unsupported configuration. Review it before retrying.",
    "codex_registration_conflict",
  );
}

function configUnavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Codex configuration is unavailable. Update Codex and retry setup.",
    "codex_config_unavailable",
  );
}

function unsafeConfigPath(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Codex configuration must be an owned, private, non-linked local path.",
    "unsafe_codex_config_path",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
