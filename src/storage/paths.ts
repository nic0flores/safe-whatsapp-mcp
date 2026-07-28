// Agent context note: Centralizes every private local-state path, including the destructive-cleanup ownership marker. Tests: test/core-config-storage.test.mjs and test/account-lifecycle.test.mjs. Never add an outbound path outside rootDir; update this note after meaningful behavior changes.
import os from "node:os";
import path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { STATE_DIR_ENV } from "../constants.js";
import { SafeWhatsAppError } from "../errors.js";

export class StatePaths {
  readonly rootDir: string;

  constructor(rootDir = process.env[STATE_DIR_ENV] || path.join(os.homedir(), ".safe-whatsapp-mcp")) {
    if (!path.isAbsolute(rootDir)) {
      throw new SafeWhatsAppError("State directory must be an absolute path.", "invalid_state_directory");
    }
    const resolved = path.resolve(rootDir);
    if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
      throw new SafeWhatsAppError("State directory cannot be a symbolic link.", "invalid_state_directory");
    }
    this.rootDir = canonicalizeFuturePath(resolved);
    const comparable = process.platform === "win32" ? this.rootDir.toLowerCase() : this.rootDir;
    const filesystemRoot = path.parse(this.rootDir).root;
    const home = path.resolve(os.homedir());
    if (
      comparable === (process.platform === "win32" ? filesystemRoot.toLowerCase() : filesystemRoot) ||
      comparable === (process.platform === "win32" ? home.toLowerCase() : home)
    ) {
      throw new SafeWhatsAppError(
        "State directory cannot be the filesystem root or home directory.",
        "invalid_state_directory",
      );
    }
  }

  get configFile(): string { return path.join(this.rootDir, "config.json"); }
  get ownershipMarker(): string { return path.join(this.rootDir, ".safe-whatsapp-mcp-state"); }
  get credentialVaultFile(): string { return path.join(this.rootDir, "credential-vault.json"); }
  get databaseFile(): string { return path.join(this.rootDir, "state.sqlite3"); }
  get lockFile(): string { return path.join(this.rootDir, "process.lock"); }
  get auditFile(): string { return path.join(this.rootDir, "audit.log"); }
  get mediaDir(): string { return path.join(this.rootDir, "media"); }
  get pendingDir(): string { return path.join(this.rootDir, "pending"); }
  get outboxDir(): string { return path.join(this.rootDir, "outbox"); }

  display(filePath = this.rootDir): string {
    const home = os.homedir();
    return filePath === home || filePath.startsWith(home + path.sep)
      ? `~${filePath.slice(home.length)}`
      : filePath;
  }
}

function canonicalizeFuturePath(target: string): string {
  const suffix: string[] = [];
  let existing = target;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...suffix);
}
