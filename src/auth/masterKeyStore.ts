// Agent context note: Lazily loads the native OS credential-vault binding and stores only the random auth-wrapping key there. Tests: test/core-credential-encryption.test.mjs and test/cli.test.mjs. Keep native-load failures inside the safe error boundary, never add an environment/file/shell/plaintext fallback, and update this note after meaningful changes.
import { SafeWhatsAppError } from "../errors.js";

const SERVICE = "safe-whatsapp-mcp.auth";

export interface MasterKeyStore {
  get(vaultId: string, keyVersion: number): Promise<Uint8Array | undefined>;
  create(vaultId: string, keyVersion: number, secret: Uint8Array): Promise<boolean>;
  /** True means the backend accepted deletion; false is always ambiguous. */
  delete(vaultId: string, keyVersion: number): Promise<boolean>;
}

export class KeyringMasterKeyStore implements MasterKeyStore {
  async get(vaultId: string, keyVersion: number): Promise<Uint8Array | undefined> {
    const account = this.account(vaultId, keyVersion);
    try {
      const entry = await createEntry(account);
      const secret = await entry.getSecret();
      if (!secret) return undefined;
      try {
        return Uint8Array.from(secret);
      } finally {
        secret.fill(0);
      }
    } catch {
      throw unavailable();
    }
  }

  async create(vaultId: string, keyVersion: number, secret: Uint8Array): Promise<boolean> {
    if (secret.byteLength !== 32) throw invalidKey();
    const account = this.account(vaultId, keyVersion);
    try {
      const entry = await createEntry(account);
      const existing = await entry.getSecret();
      if (existing) {
        existing.fill(0);
        return false;
      }
      const copy = Uint8Array.from(secret);
      try {
        await entry.setSecret(copy);
      } finally {
        copy.fill(0);
      }
      return true;
    } catch {
      throw unavailable();
    }
  }

  async delete(vaultId: string, keyVersion: number): Promise<boolean> {
    const account = this.account(vaultId, keyVersion);
    try {
      const entry = await createEntry(account);
      return await entry.deleteCredential();
    } catch {
      throw unavailable();
    }
  }

  private account(vaultId: string, keyVersion: number): string {
    if (!isUuid(vaultId) || keyVersion !== 1) throw invalidKey();
    return `master-key:${vaultId}:${keyVersion}`;
  }
}

interface AsyncKeyringEntry {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

let keyringModule: Promise<typeof import("@napi-rs/keyring")> | undefined;

async function createEntry(account: string): Promise<AsyncKeyringEntry> {
  keyringModule ??= import("@napi-rs/keyring");
  const { AsyncEntry } = await keyringModule;
  return new AsyncEntry(SERVICE, account);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function unavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The operating-system credential store is unavailable. Unlock it and retry.",
    "credential_store_unavailable",
  );
}

function invalidKey(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The credential-vault key is invalid.",
    "credential_key_invalid",
  );
}
