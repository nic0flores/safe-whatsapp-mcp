// Agent context note: Couples a strict nonsecret vault descriptor to one OS-stored auth master key. Tests: test/core-credential-encryption.test.mjs and test/account-lifecycle.test.mjs. Missing keys with ciphertext fail closed; unconfirmed deletion retains the descriptor unless ciphertext-erasure recovery explicitly abandons it; update this note after meaningful changes.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import {
  assertPrivateRegularFileOrMissing,
  chmodIfSupported,
  ensurePrivateDir,
  readJsonFile,
} from "../storage/privateFiles.js";
import { AuthRecordCipher } from "./authRecordCipher.js";
import type { MasterKeyStore } from "./masterKeyStore.js";

interface VaultDescriptor {
  version: 1;
  vaultId: string;
  keyVersion: 1;
}

export type AuthTable = "auth_credentials" | "auth_keys";

export interface CredentialRetirementOptions {
  abandonIfUnconfirmed?: boolean;
}

export class CredentialVault {
  private cipher?: AuthRecordCipher;
  private preparing?: Promise<AuthRecordCipher>;

  private constructor(
    private readonly descriptorFile: string,
    private readonly keyStore: MasterKeyStore,
    private descriptor?: VaultDescriptor,
  ) {}

  static async open(
    descriptorFile: string,
    keyStore: MasterKeyStore,
    encryptedRecordsExist: boolean,
  ): Promise<CredentialVault> {
    const raw = await readJsonFile<unknown>(descriptorFile);
    const descriptor = raw === undefined ? undefined : validateDescriptor(raw);
    if (!descriptor && encryptedRecordsExist) throw missingKey();
    const vault = new CredentialVault(descriptorFile, keyStore, descriptor);
    if (encryptedRecordsExist) await vault.requireCipher();
    return vault;
  }

  async encrypt(table: AuthTable, rowParts: readonly string[], plaintext: string): Promise<string> {
    const cipher = await this.ensureCipher();
    return cipher.encrypt(plaintext, this.aad(table, rowParts));
  }

  async decrypt(table: AuthTable, rowParts: readonly string[], ciphertext: string): Promise<string> {
    const cipher = await this.requireCipher();
    return cipher.decrypt(ciphertext, this.aad(table, rowParts));
  }

  async retire(options: CredentialRetirementOptions = {}): Promise<void> {
    this.dispose();
    if (!this.descriptor) return;
    const descriptor = this.descriptor;
    const removalConfirmed = await this.removeMasterKey(descriptor);
    if (!removalConfirmed && !options.abandonIfUnconfirmed) throw cleanupIncomplete();
    await assertPrivateRegularFileOrMissing(this.descriptorFile);
    await fs.rm(this.descriptorFile, { force: true });
    this.descriptor = undefined;
  }

  private async removeMasterKey(descriptor: VaultDescriptor): Promise<boolean> {
    try {
      const deleted = await this.keyStore.delete(descriptor.vaultId, descriptor.keyVersion);
      // The binding maps both "not found" and backend failures to false, and its
      // macOS backend can accept a delete request without propagating the result.
      if (!deleted) return false;
      const remaining = await this.keyStore.get(descriptor.vaultId, descriptor.keyVersion);
      if (!remaining) return true;
      Buffer.from(remaining.buffer, remaining.byteOffset, remaining.byteLength).fill(0);
      return false;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.cipher?.destroy();
    this.cipher = undefined;
  }

  private async ensureCipher(): Promise<AuthRecordCipher> {
    if (this.cipher) return this.cipher;
    this.preparing ??= this.prepareCipher().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async prepareCipher(): Promise<AuthRecordCipher> {
    if (this.cipher) return this.cipher;
    if (this.descriptor) return this.loadCipher();

    const descriptor: VaultDescriptor = {
      version: 1,
      vaultId: randomUUID(),
      keyVersion: 1,
    };
    const master = randomBytes(32);
    let created = false;
    try {
      created = await this.keyStore.create(descriptor.vaultId, descriptor.keyVersion, master);
      if (!created) throw new SafeWhatsAppError(
        "A credential-vault key collision occurred; retry.",
        "credential_key_collision",
      );
      const stored = await this.keyStore.get(descriptor.vaultId, descriptor.keyVersion);
      if (!stored) throw missingKey();
      const storedView = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
      try {
        if (storedView.byteLength !== 32 || !timingSafeEqual(storedView, master)) throw missingKey();
      } finally {
        storedView.fill(0);
      }
      const cipher = new AuthRecordCipher(master, descriptor.vaultId);
      try {
        await writeDescriptorExclusive(this.descriptorFile, descriptor);
      } catch (error) {
        cipher.destroy();
        throw error;
      }
      this.descriptor = descriptor;
      this.cipher = cipher;
      return this.cipher;
    } catch (error) {
      if (created) await this.keyStore.delete(descriptor.vaultId, descriptor.keyVersion).catch(() => false);
      throw error;
    } finally {
      master.fill(0);
    }
  }

  private async requireCipher(): Promise<AuthRecordCipher> {
    if (this.cipher) return this.cipher;
    if (this.preparing) return this.preparing;
    if (!this.descriptor) throw missingKey();
    return this.loadCipher();
  }

  private async loadCipher(): Promise<AuthRecordCipher> {
    const descriptor = this.descriptor!;
    const master = await this.keyStore.get(descriptor.vaultId, descriptor.keyVersion);
    if (!master || master.byteLength !== 32) throw missingKey();
    try {
      this.cipher = new AuthRecordCipher(master, descriptor.vaultId);
      return this.cipher;
    } finally {
      Buffer.from(master.buffer, master.byteOffset, master.byteLength).fill(0);
    }
  }

  private aad(table: AuthTable, rowParts: readonly string[]): string {
    if (!this.descriptor) throw missingKey();
    return JSON.stringify([
      "safe-whatsapp-mcp",
      1,
      this.descriptor.vaultId,
      table,
      ...rowParts,
    ]);
  }
}

export async function retireStoredCredentialVault(
  descriptorFile: string,
  keyStore: MasterKeyStore,
  options: CredentialRetirementOptions = {},
): Promise<void> {
  const vault = await CredentialVault.open(descriptorFile, keyStore, false);
  await vault.retire(options);
}

async function writeDescriptorExclusive(
  filePath: string,
  descriptor: VaultDescriptor,
): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  await assertPrivateRegularFileOrMissing(filePath);
  const handle = await fs.open(filePath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await chmodIfSupported(filePath, 0o600);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateDescriptor(value: unknown): VaultDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidDescriptor();
  const input = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(["keyVersion", "vaultId", "version"]) ||
      input.version !== 1 || input.keyVersion !== 1 || typeof input.vaultId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.vaultId)) {
    throw invalidDescriptor();
  }
  return input as unknown as VaultDescriptor;
}

function missingKey(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Encrypted WhatsApp credentials exist, but their operating-system credential-vault key is unavailable. Purge and re-pair if the key cannot be restored.",
    "credential_key_missing",
  );
}

function invalidDescriptor(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The credential-vault descriptor is invalid.",
    "credential_vault_invalid",
  );
}

function cleanupIncomplete(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Local account data was cleared, but operating-system credential-vault key removal could not be confirmed. Retry, or run `safewhatsapp purge --yes --abandon-key` to permit re-pairing while leaving a possibly orphaned wrapping key in the OS credential store.",
    "credential_cleanup_incomplete",
  );
}
