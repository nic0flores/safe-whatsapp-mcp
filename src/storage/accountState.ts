// Agent context note: Owns the state marker, recognizes independent auth/cache vault descriptors plus broker coordination files, and clears account tables/files/journals while preserving config/outbox. Tests: test/account-lifecycle.test.mjs, test/core-lifecycle.test.mjs, and broker tests. Keep cleanup schema-agnostic, match only producer-shaped artifacts, and run destructive operations only while the process lock is held.
import { promises as fs } from "node:fs";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import type { SqliteState } from "./database.js";
import {
  assertPrivateRegularFileOrMissing,
  chmodIfSupported,
  isNodeError,
} from "./privateFiles.js";
import type { StatePaths } from "./paths.js";

const OWNERSHIP_MARKER_CONTENT = "safe-whatsapp-mcp-state-v1\n";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export async function ensureStateOwnership(paths: StatePaths): Promise<void> {
  await assertPrivateRegularFileOrMissing(paths.ownershipMarker);
  try {
    const content = await fs.readFile(paths.ownershipMarker, "utf8");
    if (content !== OWNERSHIP_MARKER_CONTENT) throw invalidOwnershipMarker();
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const unexpected = (await fs.readdir(paths.rootDir)).filter((entry) => !isKnownStateEntry(paths, entry));
  if (unexpected.length > 0) {
    throw new SafeWhatsAppError(
      "State directory contains files not owned by Safe WhatsApp MCP; choose a dedicated empty directory.",
      "unowned_state_directory",
    );
  }
  await fs.writeFile(paths.ownershipMarker, OWNERSHIP_MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  await chmodIfSupported(paths.ownershipMarker, 0o600);
}

export async function assertStateOwnership(paths: StatePaths): Promise<void> {
  await assertPrivateRegularFileOrMissing(paths.ownershipMarker);
  let content: string;
  try {
    content = await fs.readFile(paths.ownershipMarker, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw missingOwnershipMarker();
    throw error;
  }
  if (content !== OWNERSHIP_MARKER_CONTENT) throw invalidOwnershipMarker();
}

export async function clearAccountBoundState(state: SqliteState): Promise<void> {
  await assertStateOwnership(state.paths);
  clearAllApplicationTables(state);
  await Promise.all([
    fs.rm(state.paths.mediaDir, { recursive: true, force: true }),
    fs.rm(state.paths.pendingDir, { recursive: true, force: true }),
    fs.rm(state.paths.auditFile, { force: true }),
    removeDatabaseJournal(state.paths),
    removeAuditTemporaryFiles(state.paths.rootDir, state.paths.auditFile),
  ]);
}

function clearAllApplicationTables(state: SqliteState): void {
  const rows = state.db.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[];
  state.db.transaction(() => {
    state.db.pragma("defer_foreign_keys = ON");
    for (const { name } of rows) state.db.exec(`DELETE FROM ${quotedIdentifier(name)}`);
  })();
  state.db.pragma("wal_checkpoint(TRUNCATE)");
  state.hardenFiles();
}

async function removeAuditTemporaryFiles(rootDir: string, auditFile: string): Promise<void> {
  const pattern = new RegExp(
    `^${escapePattern(path.basename(auditFile))}\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp$`,
    "iu",
  );
  const entries = await fs.readdir(rootDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => pattern.test(entry))
    .map((entry) => fs.rm(path.join(rootDir, entry), { force: true })));
}

async function removeDatabaseJournal(paths: StatePaths): Promise<void> {
  const journal = `${paths.databaseFile}-journal`;
  let stat;
  try {
    stat = await fs.lstat(journal);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new SafeWhatsAppError(
      "The SQLite rollback journal path is unsafe.",
      "unsafe_state_path",
    );
  }
  await fs.unlink(journal);
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isKnownStateEntry(paths: StatePaths, entry: string): boolean {
  const exact = new Set([
    path.basename(paths.ownershipMarker),
    path.basename(paths.credentialVaultFile),
    path.basename(paths.cacheVaultFile),
    path.basename(paths.configFile),
    path.basename(paths.databaseFile),
    path.basename(paths.mediaDir),
    path.basename(paths.pendingDir),
    path.basename(paths.outboxDir),
    path.basename(paths.auditFile),
    path.basename(paths.lockFile),
    path.basename(paths.brokerFile),
    path.basename(paths.brokerLaunchLockFile),
    `${path.basename(paths.databaseFile)}-wal`,
    `${path.basename(paths.databaseFile)}-shm`,
    `${path.basename(paths.databaseFile)}-journal`,
    `${path.basename(paths.lockFile)}.reclaim`,
    `${path.basename(paths.brokerLaunchLockFile)}.reclaim`,
  ]);
  if (exact.has(entry)) return true;
  return isOwnedStateTemporaryEntry(paths, entry);
}

export function isOwnedStateTemporaryEntry(paths: StatePaths, entry: string): boolean {
  const lock = path.basename(paths.lockFile);
  const launchLock = path.basename(paths.brokerLaunchLockFile);
  const config = path.basename(paths.configFile);
  const broker = path.basename(paths.brokerFile);
  const audit = path.basename(paths.auditFile);
  const alternatives = [
    `${escapePattern(lock)}\\.candidate\\.${UUID_PATTERN}`,
    `${escapePattern(lock)}\\.stale\\.${UUID_PATTERN}`,
    `${escapePattern(lock)}\\.reclaim\\.stale\\.${UUID_PATTERN}`,
    `${escapePattern(launchLock)}\\.candidate\\.${UUID_PATTERN}`,
    `${escapePattern(launchLock)}\\.stale\\.${UUID_PATTERN}`,
    `${escapePattern(launchLock)}\\.reclaim\\.stale\\.${UUID_PATTERN}`,
    `\\.${escapePattern(config)}\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp`,
    `\\.${escapePattern(broker)}\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp`,
    `${escapePattern(audit)}\\.[1-9]\\d*\\.${UUID_PATTERN}\\.tmp`,
  ];
  return new RegExp(`^(?:${alternatives.join("|")})$`, "iu").test(entry);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function missingOwnershipMarker(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Refusing destructive cleanup because this directory was not initialized by Safe WhatsApp MCP.",
    "unowned_state_directory",
  );
}

function invalidOwnershipMarker(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Refusing destructive cleanup because the Safe WhatsApp MCP state marker is invalid.",
    "invalid_state_ownership_marker",
  );
}
