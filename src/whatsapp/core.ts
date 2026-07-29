// Agent context note: Composes the locked production stack and OS-vault-backed connect/unlink/purge lifecycle. Tests: test/core-lifecycle.test.mjs and test/account-lifecycle.test.mjs. Quiesce auth writes before cleanup, retire wrapping keys with explicit post-erasure abandonment only, require ownership for destructive work, and preserve config/outbox; update this note after meaningful changes.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { retireStoredCredentialVault } from "../auth/credentialVault.js";
import { KeyringMasterKeyStore, type MasterKeyStore } from "../auth/masterKeyStore.js";
import { SqliteAuthState } from "../auth/sqliteAuthState.js";
import { IdentityStore } from "../messages/identityStore.js";
import { MessageStore } from "../messages/messageStore.js";
import {
  assertStateOwnership,
  clearAccountBoundState,
  ensureStateOwnership,
  isOwnedStateTemporaryEntry,
} from "../storage/accountState.js";
import { SqliteState } from "../storage/database.js";
import type { StatePaths } from "../storage/paths.js";
import { ProcessLock } from "../storage/processLock.js";
import { BaileysSocketFactory } from "./baileysSocketFactory.js";
import { WhatsAppClient } from "./client.js";
import { EventRouter } from "./eventRouter.js";
import { SessionManager } from "./sessionManager.js";

export interface CoreOptions {
  onQr?(qr: string): void;
  onPairingAccepted?(): void;
  connectionTimeoutMs?: number;
  syncTimeoutMs?: number;
  clearResidualIfUnpaired?: boolean;
  masterKeyStore?: MasterKeyStore;
}

export interface UnlinkResult {
  wasPaired: boolean;
  remoteLogout: "requested" | "not-paired" | "unconfirmed";
}

export interface PurgeOptions {
  abandonCredentialKey?: boolean;
  masterKeyStore?: MasterKeyStore;
}

export class WhatsAppCore {
  private constructor(
    readonly state: SqliteState,
    readonly auth: SqliteAuthState,
    readonly messages: MessageStore,
    readonly sessions: SessionManager,
    readonly client: WhatsAppClient,
    private readonly lock: ProcessLock,
  ) {}

  static async open(
    paths: StatePaths,
    config: SafeWhatsAppConfig,
    options: CoreOptions = {},
  ): Promise<WhatsAppCore> {
    const lock = new ProcessLock(paths.lockFile);
    await lock.acquire();
    let state: SqliteState | undefined;
    let auth: SqliteAuthState | undefined;
    try {
      await ensureStateOwnership(paths);
      state = await SqliteState.open(paths);
      const keyStore = options.masterKeyStore ?? new KeyringMasterKeyStore();
      auth = await SqliteAuthState.open(state, keyStore);
      if (options.clearResidualIfUnpaired && !auth.isPaired()) {
        await auth.quiesceCredentialState();
        await clearAccountBoundState(state);
        await auth.retireCredentialVault();
        await auth.close();
        auth = await SqliteAuthState.open(state, keyStore);
      }
      const identities = new IdentityStore(state);
      const messages = new MessageStore(state, identities, config);
      const router = new EventRouter(auth, messages);
      const factory = new BaileysSocketFactory(auth);
      const sessions = new SessionManager(factory, router, {
        syncTimeoutMs: options.syncTimeoutMs ?? config.syncTimeoutMs,
        connectionTimeoutMs: options.connectionTimeoutMs ?? config.connectionTimeoutMs,
        connectionBudgetMs: options.connectionTimeoutMs ?? 50_000,
        idleTimeoutMs: config.idleTimeoutMs,
        onQr: options.onQr,
        onPairingAccepted: options.onPairingAccepted,
      });
      const client = new WhatsAppClient(
        state,
        messages,
        sessions,
        config,
        undefined,
        () => auth!.isPaired(),
      );
      return new WhatsAppCore(state, auth, messages, sessions, client, lock);
    } catch (error) {
      try {
        await auth?.close().catch(() => undefined);
      } finally {
        try {
          state?.close();
        } finally {
          await lock.release();
        }
      }
      throw error;
    }
  }

  async unlink(): Promise<UnlinkResult> {
    const wasPaired = this.client.status().paired;
    let remoteLogout: UnlinkResult["remoteLogout"] = wasPaired ? "unconfirmed" : "not-paired";
    if (wasPaired) {
      try {
        await this.client.unlinkRemote();
        remoteLogout = "requested";
      } catch {
        await this.client.disconnect().catch(() => undefined);
      }
    }
    await this.auth.quiesceCredentialState();
    await clearAccountBoundState(this.state);
    await this.auth.retireCredentialVault();
    return { wasPaired, remoteLogout };
  }

  async close(): Promise<void> {
    try {
      await this.client.disconnect();
    } finally {
      try {
        await this.auth.close();
      } finally {
        try {
          this.state.close();
        } finally {
          await this.lock.release();
        }
      }
    }
  }
}

export async function purgeLocalState(
  paths: StatePaths,
  options: PurgeOptions = {},
): Promise<void> {
  const keyStore = options.masterKeyStore ?? new KeyringMasterKeyStore();
  const lock = new ProcessLock(paths.lockFile);
  await lock.acquire();
  try {
    await assertStateOwnership(paths);
    const exactTargets = [
      paths.configFile,
      paths.databaseFile,
      `${paths.databaseFile}-wal`,
      `${paths.databaseFile}-shm`,
      `${paths.databaseFile}-journal`,
      paths.mediaDir,
      paths.pendingDir,
      paths.auditFile,
      paths.brokerFile,
      `${paths.lockFile}.reclaim`,
    ];
    for (const target of exactTargets) await fs.rm(target, { recursive: true, force: true });
    await retireStoredCredentialVault(paths.credentialVaultFile, keyStore, {
      abandonIfUnconfirmed: options.abandonCredentialKey,
    });
    const entries = await fs.readdir(paths.rootDir).catch(() => []);
    for (const entry of entries) {
      if (isOwnedStateTemporaryEntry(paths, entry)) {
        await fs.rm(path.join(paths.rootDir, entry), { recursive: true, force: true });
      }
    }
  } finally {
    await lock.release();
  }
}
