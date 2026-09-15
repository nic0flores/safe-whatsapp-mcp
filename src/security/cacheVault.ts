// Agent context note: Owns a cache-only OS credential-store key and strict nonsecret descriptor. It is independent from the auth vault so cache compromise does not expose linked-device credentials.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";
import type { MasterKeyStore } from "../auth/masterKeyStore.js";
import {
  assertPrivateRegularFileOrMissing,
  chmodIfSupported,
  ensurePrivateDir,
  readJsonFile,
} from "../storage/privateFiles.js";
import { CacheRecordCipher } from "./cacheRecordCipher.js";

export type CacheField =
  | "identity_display_name"
  | "chat_title"
  | "message_text"
  | "message_media_filename";

interface CacheVaultDescriptor {
  version: 1;
  vaultId: string;
  keyVersion: 1;
}

export interface CacheVaultRetirementOptions {
  abandonIfUnconfirmed?: boolean;
}

export class CacheVault {
  private constructor(
    private readonly descriptorFile: string,
    private readonly keyStore: MasterKeyStore,
    private descriptor: CacheVaultDescriptor,
    private cipher: CacheRecordCipher,
  ) {}

  static async open(
    descriptorFile: string,
    keyStore: MasterKeyStore,
    encryptedRecordsExist: boolean,
  ): Promise<CacheVault> {
    const raw = await readJsonFile<unknown>(descriptorFile);
    const descriptor = raw === undefined ? undefined : validateDescriptor(raw);
    if (!descriptor && encryptedRecordsExist) throw missingKey();
    if (descriptor) return CacheVault.load(descriptorFile, keyStore, descriptor);
    return CacheVault.create(descriptorFile, keyStore);
  }

  encrypt(field: CacheField, rowId: string, plaintext: string): string {
    return this.cipher.encrypt(plaintext, this.aad(field, rowId));
  }

  decrypt(field: CacheField, rowId: string, ciphertext: string): string {
    return this.cipher.decrypt(ciphertext, this.aad(field, rowId));
  }

  dispose(): void {
    this.cipher.destroy();
  }

  async retire(options: CacheVaultRetirementOptions = {}): Promise<void> {
    this.dispose();
    const descriptor = this.descriptor;
    const removalConfirmed = await this.removeMasterKey(descriptor);
    if (!removalConfirmed && !options.abandonIfUnconfirmed) throw cleanupIncomplete();
    await assertPrivateRegularFileOrMissing(this.descriptorFile);
    await fs.rm(this.descriptorFile, { force: true });
  }

  private aad(field: CacheField, rowId: string): string {
    return JSON.stringify([
      "safe-whatsapp-mcp-cache",
      1,
      this.descriptor.vaultId,
      field,
      rowId,
    ]);
  }

  private async removeMasterKey(descriptor: CacheVaultDescriptor): Promise<boolean> {
    try {
      const deleted = await this.keyStore.delete(descriptor.vaultId, descriptor.keyVersion);
      if (!deleted) return false;
      const remaining = await this.keyStore.get(descriptor.vaultId, descriptor.keyVersion);
      if (!remaining) return true;
      Buffer.from(remaining.buffer, remaining.byteOffset, remaining.byteLength).fill(0);
      return false;
    } catch {
      return false;
    }
  }

  private static async create(
    descriptorFile: string,
    keyStore: MasterKeyStore,
  ): Promise<CacheVault> {
    const descriptor: CacheVaultDescriptor = {
      version: 1,
      vaultId: randomUUID(),
      keyVersion: 1,
    };
    const master = randomBytes(32);
    let created = false;
    try {
      created = await keyStore.create(descriptor.vaultId, descriptor.keyVersion, master);
      if (!created) throw new SafeWhatsAppError(
        "A cache-vault key collision occurred; retry.",
        "cache_key_collision",
      );
      const stored = await keyStore.get(descriptor.vaultId, descriptor.keyVersion);
      if (!stored) throw missingKey();
      const storedView = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
      try {
        if (storedView.byteLength !== 32 || !timingSafeEqual(storedView, master)) throw missingKey();
      } finally {
        storedView.fill(0);
      }
      const cipher = new CacheRecordCipher(master, descriptor.vaultId);
      try {
        await writeDescriptorExclusive(descriptorFile, descriptor);
      } catch (error) {
        cipher.destroy();
        throw error;
      }
      return new CacheVault(descriptorFile, keyStore, descriptor, cipher);
    } catch (error) {
      if (created) await keyStore.delete(descriptor.vaultId, descriptor.keyVersion).catch(() => false);
      throw error;
    } finally {
      master.fill(0);
    }
  }

  static async load(
    descriptorFile: string,
    keyStore: MasterKeyStore,
    descriptor: CacheVaultDescriptor,
  ): Promise<CacheVault> {
    const master = await keyStore.get(descriptor.vaultId, descriptor.keyVersion);
    if (!master || master.byteLength !== 32) throw missingKey();
    try {
      return new CacheVault(
        descriptorFile,
        keyStore,
        descriptor,
        new CacheRecordCipher(master, descriptor.vaultId),
      );
    } finally {
      Buffer.from(master.buffer, master.byteOffset, master.byteLength).fill(0);
    }
  }
}

export async function retireStoredCacheVault(
  descriptorFile: string,
  keyStore: MasterKeyStore,
  options: CacheVaultRetirementOptions = {},
): Promise<void> {
  const raw = await readJsonFile<unknown>(descriptorFile);
  if (raw === undefined) return;
  const descriptor = validateDescriptor(raw);
  const master = await keyStore.get(descriptor.vaultId, descriptor.keyVersion);
  if (!master || master.byteLength !== 32) {
    if (!options.abandonIfUnconfirmed) throw missingKey();
    await fs.rm(descriptorFile, { force: true });
    return;
  }
  Buffer.from(master.buffer, master.byteOffset, master.byteLength).fill(0);
  const vault = await CacheVault.load(descriptorFile, keyStore, descriptor);
  await vault.retire(options);
}

async function writeDescriptorExclusive(
  filePath: string,
  descriptor: CacheVaultDescriptor,
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

function validateDescriptor(value: unknown): CacheVaultDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidDescriptor();
  const input = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(["keyVersion", "vaultId", "version"]) ||
      input.version !== 1 || input.keyVersion !== 1 || typeof input.vaultId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.vaultId)) {
    throw invalidDescriptor();
  }
  return input as unknown as CacheVaultDescriptor;
}

function missingKey(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Encrypted WhatsApp cache exists, but its operating-system cache-vault key is unavailable. Purge the local cache if the key cannot be restored.",
    "cache_key_missing",
  );
}

function invalidDescriptor(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The WhatsApp cache-vault descriptor is invalid.",
    "cache_vault_invalid",
  );
}

function cleanupIncomplete(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The WhatsApp cache-vault key could not be confirmed deleted.",
    "cache_key_cleanup_incomplete",
  );
}
