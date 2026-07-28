// Agent context note: Adapts encrypted transactional SQLite rows to Baileys' complete AuthenticationState contract. Tests: test/core-database-auth.test.mjs and test/core-credential-encryption.test.mjs. Hydrate only authenticated ciphertext, recognize Baileys QR-paired identity state, serialize writes, and never allow a closed/retired state to recreate vault material; update this note after meaningful changes.
import {
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from "baileys";
import { SafeWhatsAppError } from "../errors.js";
import type { SqliteState } from "../storage/database.js";
import { CredentialVault } from "./credentialVault.js";
import { KeyringMasterKeyStore, type MasterKeyStore } from "./masterKeyStore.js";
import { decodeBaileys, encodeBaileys } from "./serialization.js";

interface EncryptedRow {
  ciphertext: string;
  updated_at: number;
}

interface CredentialRow extends EncryptedRow {
  registered: number;
}

export class SqliteAuthState {
  readonly state: AuthenticationState;
  private mutations = Promise.resolve();
  private acceptingOperations = true;

  private constructor(
    private readonly storage: SqliteState,
    private readonly vault: CredentialVault,
    private readonly creds: AuthenticationCreds,
  ) {
    this.state = { creds: this.creds, keys: this.createKeyStore() };
  }

  static async open(
    storage: SqliteState,
    keyStore: MasterKeyStore = new KeyringMasterKeyStore(),
  ): Promise<SqliteAuthState> {
    const vault = await CredentialVault.open(
      storage.paths.credentialVaultFile,
      keyStore,
      storage.hasAuthRecords(),
    );
    const row = storage.db.prepare(`
      SELECT ciphertext, registered, updated_at FROM auth_credentials WHERE id = 1
    `).get() as CredentialRow | undefined;
    if (!row) return new SqliteAuthState(storage, vault, initAuthCreds());
    try {
      const plaintext = await vault.decrypt(
        "auth_credentials",
        ["1", String(row.updated_at)],
        row.ciphertext,
      );
      const creds = decodeBaileys<AuthenticationCreds>(plaintext);
      if (!creds || typeof creds !== "object" ||
          Boolean(creds.registered) !== (row.registered === 1)) throw invalidAuth();
      return new SqliteAuthState(storage, vault, creds);
    } catch (error) {
      vault.dispose();
      if (error instanceof SafeWhatsAppError) throw error;
      throw invalidAuth();
    }
  }

  isPaired(): boolean {
    const id = this.creds.me?.id;
    return this.creds.registered === true ||
      (typeof id === "string" && id.length > 0 && Boolean(this.creds.account));
  }

  saveCreds(update?: Partial<AuthenticationCreds>): Promise<void> {
    if (!this.acceptingOperations) return Promise.reject(inactiveAuth());
    return this.enqueue(async () => {
      if (update) Object.assign(this.creds, update);
      const updatedAt = Date.now();
      const ciphertext = await this.vault.encrypt(
        "auth_credentials",
        ["1", String(updatedAt)],
        encodeBaileys(this.creds),
      );
      this.storage.db.prepare(`
        INSERT INTO auth_credentials (id, ciphertext, registered, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ciphertext = excluded.ciphertext,
          registered = excluded.registered,
          updated_at = excluded.updated_at
      `).run(ciphertext, this.creds.registered ? 1 : 0, updatedAt);
      this.storage.hardenFiles();
    });
  }

  async quiesceCredentialState(): Promise<void> {
    this.acceptingOperations = false;
    await this.mutations;
  }

  async retireCredentialVault(): Promise<void> {
    await this.quiesceCredentialState();
    try {
      await this.vault.retire();
    } finally {
      resetCredentials(this.creds);
    }
  }

  async close(): Promise<void> {
    await this.quiesceCredentialState();
    this.vault.dispose();
    resetCredentials(this.creds);
  }

  private createKeyStore(): SignalKeyStore {
    return {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        if (ids.length === 0) return {};
        this.assertActive();
        await this.mutations;
        const statement = this.storage.db.prepare(`
          SELECT ciphertext, updated_at FROM auth_keys WHERE category = ? AND key_id = ?
        `);
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const row = statement.get(type, id) as EncryptedRow | undefined;
          if (!row) continue;
          const plaintext = await this.vault.decrypt(
            "auth_keys",
            [String(type), id, String(row.updated_at)],
            row.ciphertext,
          );
          let value: SignalDataTypeMap[T];
          try {
            value = decodeBaileys<SignalDataTypeMap[T]>(plaintext);
          } catch {
            throw invalidAuth();
          }
          if (type === "app-state-sync-key") {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
            ) as unknown as SignalDataTypeMap[T];
          }
          result[id] = value;
        }
        return result;
      },
      set: async (data: SignalDataSet) => {
        this.assertActive();
        return this.enqueue(async () => {
          const updates: {
            category: string;
            id: string;
            ciphertext?: string;
            updatedAt: number;
          }[] = [];
          for (const [category, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              const updatedAt = Date.now();
              updates.push({
                category,
                id,
                updatedAt,
                ...(value === null || value === undefined ? {} : {
                  ciphertext: await this.vault.encrypt(
                    "auth_keys",
                    [category, id, String(updatedAt)],
                    encodeBaileys(value),
                  ),
                }),
              });
            }
          }
          const upsert = this.storage.db.prepare(`
            INSERT INTO auth_keys (category, key_id, ciphertext, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(category, key_id) DO UPDATE SET
              ciphertext = excluded.ciphertext,
              updated_at = excluded.updated_at
          `);
          const remove = this.storage.db.prepare(
            "DELETE FROM auth_keys WHERE category = ? AND key_id = ?",
          );
          this.storage.db.transaction(() => {
            for (const update of updates) {
              if (update.ciphertext === undefined) remove.run(update.category, update.id);
              else upsert.run(update.category, update.id, update.ciphertext, update.updatedAt);
            }
          })();
          this.storage.hardenFiles();
        });
      },
      clear: async () => {
        this.assertActive();
        return this.enqueue(async () => {
          this.storage.db.prepare("DELETE FROM auth_keys").run();
        });
      },
    };
  }

  private assertActive(): void {
    if (!this.acceptingOperations) throw inactiveAuth();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }
}

function invalidAuth(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Encrypted WhatsApp credential state is invalid or could not be authenticated.",
    "auth_ciphertext_invalid",
  );
}

function inactiveAuth(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "WhatsApp credential state is closed.",
    "auth_state_closed",
  );
}

function resetCredentials(creds: AuthenticationCreds): void {
  zeroizeValues(creds, new WeakSet<object>());
  const record = creds as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) delete record[key];
  record.registered = false;
}

function zeroizeValues(value: unknown, seen: WeakSet<object>): void {
  if (!value || typeof value !== "object") return;
  if (ArrayBuffer.isView(value)) {
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
    return;
  }
  if (value instanceof ArrayBuffer) {
    new Uint8Array(value).fill(0);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) zeroizeValues(child, seen);
}
