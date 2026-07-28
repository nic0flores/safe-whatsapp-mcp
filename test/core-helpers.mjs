import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StatePaths } from "../dist/storage/paths.js";
import { SqliteState } from "../dist/storage/database.js";

export const runtimeConfig = {
  retentionMs: 7 * 86_400_000,
  maxMessagesPerChat: 200,
  pendingTtlMs: 10 * 60_000,
  connectionTimeoutMs: 15_000,
  syncTimeoutMs: 15_000,
  idleTimeoutMs: 60_000,
  inlineMediaBytes: 8 * 1_048_576,
  maxMediaBytes: 25 * 1_048_576,
  sendEnabled: false,
  mediaSendEnabled: false,
};

export class MemoryMasterKeyStore {
  keys = new Map();
  getCalls = 0;
  createCalls = 0;
  deleteCalls = 0;

  async get(vaultId, keyVersion) {
    this.getCalls += 1;
    const value = this.keys.get(`${vaultId}:${keyVersion}`);
    return value ? Uint8Array.from(value) : undefined;
  }

  async create(vaultId, keyVersion, value) {
    this.createCalls += 1;
    const id = `${vaultId}:${keyVersion}`;
    if (this.keys.has(id)) return false;
    this.keys.set(id, Uint8Array.from(value));
    return true;
  }

  async delete(vaultId, keyVersion) {
    this.deleteCalls += 1;
    return this.keys.delete(`${vaultId}:${keyVersion}`);
  }
}

export async function temporaryState() {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-wa-core-"));
  const paths = new StatePaths(root);
  const state = await SqliteState.open(paths);
  const masterKeyStore = new MemoryMasterKeyStore();
  return {
    root,
    paths,
    state,
    masterKeyStore,
    async cleanup() {
      state.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function directMessage({
  id,
  jid = "919999999999@s.whatsapp.net",
  text = `message-${id}`,
  timestamp = Math.floor(Date.now() / 1_000),
  fromMe = false,
  message,
}) {
  return {
    key: { id, remoteJid: jid, fromMe },
    messageTimestamp: timestamp,
    message: message ?? { conversation: text },
  };
}
