// Agent context note: Validates local runtime settings and resolves hardened read-only defaults. Tests: test/core-config-storage.test.mjs. V1 must never enable outbound WhatsApp transport from environment flags.
import { readJsonFile } from "../storage/privateFiles.js";
import type { StatePaths } from "../storage/paths.js";
import { SafeWhatsAppError } from "../errors.js";

export interface LocalConfig {
  retentionDays?: number;
  maxMessagesPerChat?: number;
  pendingTtlMinutes?: number;
  connectionTimeoutSeconds?: number;
  syncTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  inlineMediaMiB?: number;
  maxMediaMiB?: number;
}

export interface SafeWhatsAppConfig {
  retentionMs: number;
  maxMessagesPerChat: number;
  pendingTtlMs: number;
  connectionTimeoutMs: number;
  syncTimeoutMs: number;
  idleTimeoutMs: number;
  inlineMediaBytes: number;
  maxMediaBytes: number;
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
}

export const DEFAULT_LOCAL_CONFIG: Required<LocalConfig> = Object.freeze({
  retentionDays: 3,
  maxMessagesPerChat: 100,
  pendingTtlMinutes: 10,
  connectionTimeoutSeconds: 15,
  syncTimeoutSeconds: 15,
  idleTimeoutSeconds: 60,
  inlineMediaMiB: 8,
  maxMediaMiB: 25,
});

const CONFIG_MAXIMUMS: Required<LocalConfig> = Object.freeze({
  retentionDays: 3_650,
  maxMessagesPerChat: 10_000,
  pendingTtlMinutes: 1_440,
  connectionTimeoutSeconds: 600,
  syncTimeoutSeconds: 120,
  idleTimeoutSeconds: 3_600,
  inlineMediaMiB: 8,
  maxMediaMiB: 25,
});

export class ConfigLoader {
  constructor(private readonly paths: StatePaths) {}

  async load(): Promise<SafeWhatsAppConfig> {
    const local = validateConfig(await readJsonFile<unknown>(this.paths.configFile));
    const resolved = { ...DEFAULT_LOCAL_CONFIG, ...local };
    if (resolved.inlineMediaMiB > resolved.maxMediaMiB) {
      throw new SafeWhatsAppError(
        "inlineMediaMiB cannot exceed maxMediaMiB.",
        "invalid_config",
      );
    }
    return {
      retentionMs: resolved.retentionDays * 86_400_000,
      maxMessagesPerChat: resolved.maxMessagesPerChat,
      pendingTtlMs: resolved.pendingTtlMinutes * 60_000,
      connectionTimeoutMs: resolved.connectionTimeoutSeconds * 1_000,
      syncTimeoutMs: resolved.syncTimeoutSeconds * 1_000,
      idleTimeoutMs: resolved.idleTimeoutSeconds * 1_000,
      inlineMediaBytes: resolved.inlineMediaMiB * 1_048_576,
      maxMediaBytes: resolved.maxMediaMiB * 1_048_576,
      sendEnabled: false,
      mediaSendEnabled: false,
    };
  }
}

export function validateConfig(raw: unknown): LocalConfig {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SafeWhatsAppError("Config must contain a JSON object.", "invalid_config");
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set<keyof LocalConfig>([
    "retentionDays",
    "maxMessagesPerChat",
    "pendingTtlMinutes",
    "connectionTimeoutSeconds",
    "syncTimeoutSeconds",
    "idleTimeoutSeconds",
    "inlineMediaMiB",
    "maxMediaMiB",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key as keyof LocalConfig))) {
    throw new SafeWhatsAppError("Config contains an unsupported setting.", "invalid_config");
  }
  return {
    retentionDays: boundedNumber(input.retentionDays, "retentionDays"),
    maxMessagesPerChat: positiveInteger(
      input.maxMessagesPerChat,
      "maxMessagesPerChat",
    ),
    pendingTtlMinutes: boundedNumber(
      input.pendingTtlMinutes,
      "pendingTtlMinutes",
    ),
    connectionTimeoutSeconds: boundedNumber(
      input.connectionTimeoutSeconds,
      "connectionTimeoutSeconds",
    ),
    syncTimeoutSeconds: boundedNumber(
      input.syncTimeoutSeconds,
      "syncTimeoutSeconds",
    ),
    idleTimeoutSeconds: boundedNumber(
      input.idleTimeoutSeconds,
      "idleTimeoutSeconds",
    ),
    inlineMediaMiB: boundedNumber(input.inlineMediaMiB, "inlineMediaMiB"),
    maxMediaMiB: boundedNumber(input.maxMediaMiB, "maxMediaMiB"),
  };
}

function positiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SafeWhatsAppError(`${name} must be a positive number.`, "invalid_config");
  }
  return value;
}

function positiveInteger(value: unknown, name: keyof LocalConfig): number | undefined {
  const number = boundedNumber(value, name);
  if (number !== undefined && !Number.isSafeInteger(number)) {
    throw new SafeWhatsAppError(`${name} must be a positive integer.`, "invalid_config");
  }
  return number;
}

function boundedNumber(value: unknown, name: keyof LocalConfig): number | undefined {
  const number = positiveNumber(value, name);
  if (number !== undefined && number > CONFIG_MAXIMUMS[name]) {
    throw new SafeWhatsAppError(
      `${name} cannot exceed ${CONFIG_MAXIMUMS[name]}.`,
      "invalid_config",
    );
  }
  return number;
}
