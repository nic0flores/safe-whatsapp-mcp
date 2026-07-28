// Agent context note: Owns the versioned SQLite schema and fail-closed privacy migrations. Tests: test/core-database-auth.test.mjs and test/core-credential-encryption.test.mjs. Auth ciphertext, raw envelopes, group rosters, and unknown legacy source times migrate transactionally; v7 plaintext auth is deliberately scrubbed instead of retained.
import Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import type { StatePaths } from "./paths.js";
import { normalizeNativeDependencyError } from "./nativeDependencyError.js";
import { assertPrivateRegularFileOrMissing, ensurePrivateDir } from "./privateFiles.js";

export type DatabaseHandle = InstanceType<typeof Database>;

export interface StateCounts {
  chats: number;
  messages: number;
  identities: number;
}

export class SqliteState {
  readonly db: DatabaseHandle;

  private constructor(readonly paths: StatePaths) {
    this.db = openDatabase(paths.databaseFile);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("secure_delete = ON");
      if (migrate(this.db)) {
        scrubDeletedAuthPages(this.db);
        // Keep v7 until the out-of-transaction scrub succeeds. If this process
        // stops early, the next open safely repeats the empty auth-table reset.
        this.db.pragma("user_version = 8");
      }
      this.hardenFiles();
    } catch (error) {
      if (this.db.open) this.db.close();
      throw normalizeNativeDependencyError(error);
    }
  }

  static async open(paths: StatePaths): Promise<SqliteState> {
    await ensurePrivateDir(paths.rootDir);
    await Promise.all([
      assertPrivateRegularFileOrMissing(paths.databaseFile),
      assertPrivateRegularFileOrMissing(`${paths.databaseFile}-wal`),
      assertPrivateRegularFileOrMissing(`${paths.databaseFile}-shm`),
      assertPrivateRegularFileOrMissing(`${paths.databaseFile}-journal`),
    ]);
    await Promise.all([
      ensurePrivateDir(paths.mediaDir),
      ensurePrivateDir(paths.pendingDir),
      ensurePrivateDir(paths.outboxDir),
    ]);
    return new SqliteState(paths);
  }

  hasAuthRecords(): boolean {
    const row = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM auth_credentials
        UNION ALL
        SELECT 1 FROM auth_keys
      ) AS present
    `).get() as { present: number };
    return row.present === 1;
  }

  counts(): StateCounts {
    const count = (table: "chats" | "messages" | "identities") =>
      (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    return { chats: count("chats"), messages: count("messages"), identities: count("identities") };
  }

  close(): void {
    if (!this.db.open) return;
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.hardenFiles();
  }

  hardenFiles(): void {
    if (process.platform === "win32") return;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = `${this.paths.databaseFile}${suffix}`;
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}

function openDatabase(filePath: string): DatabaseHandle {
  try {
    return new Database(filePath);
  } catch (error) {
    throw normalizeNativeDependencyError(error);
  }
}

function migrate(db: DatabaseHandle): boolean {
  let version = db.pragma("user_version", { simple: true }) as number;
  if (version > 8) throw new Error(`Unsupported state database version ${version}.`);
  if (version === 0) {
    db.transaction(() => {
      db.exec(`
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL,
        registered INTEGER NOT NULL CHECK (registered IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_keys (
        category TEXT NOT NULL,
        key_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (category, key_id)
      );
      CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        e164 TEXT UNIQUE,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE identity_aliases (
        jid TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('pn', 'lid')),
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX identity_aliases_identity_idx ON identity_aliases(identity_id);
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        transport_jid TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
        identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
        title TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        updated_at INTEGER NOT NULL,
        raw_json TEXT
      );
      CREATE INDEX chats_activity_idx ON chats(last_message_at DESC, id);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        transport_chat_jid TEXT NOT NULL,
        participant_jid TEXT,
        sender_identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
        sender_e164 TEXT,
        from_me INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        source_timestamp_valid INTEGER NOT NULL DEFAULT 0,
        text TEXT,
        media_kind TEXT,
        media_mime TEXT,
        media_filename TEXT,
        media_size INTEGER,
        quoted_source_id TEXT,
        edited_at INTEGER,
        deleted_at INTEGER,
        expires_at INTEGER,
        view_once INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (transport_chat_jid, source_id)
      );
      CREATE INDEX messages_chat_time_idx ON messages(chat_id, timestamp DESC, id);
      CREATE INDEX messages_expiry_idx ON messages(expires_at);
      CREATE TABLE message_tombstones (
        transport_chat_jid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (transport_chat_jid, source_id)
      );
      CREATE INDEX message_tombstones_age_idx ON message_tombstones(deleted_at);
      CREATE TABLE chat_clear_tombstones (
        transport_chat_jid TEXT PRIMARY KEY,
        cleared_at INTEGER NOT NULL
      );
      CREATE INDEX chat_clear_tombstones_age_idx ON chat_clear_tombstones(cleared_at);
      CREATE TABLE groups (
        transport_jid TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE local_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
        PRAGMA user_version = 8;
      `);
    })();
    return false;
  }
  if (version === 1) {
    db.transaction(() => {
      db.prepare("UPDATE chats SET raw_json = NULL").run();
      db.prepare("UPDATE messages SET raw_json = NULL").run();
      db.pragma("user_version = 2");
    })();
    version = 2;
  }
  if (version === 2) {
    migrateFromTwo(db);
    version = 3;
  }
  if (version === 3) {
    migrateFromThree(db);
    version = 4;
  }
  if (version === 4) {
    migrateFromFour(db);
    version = 5;
  }
  if (version === 5) {
    migrateFromFive(db);
    version = 6;
  }
  if (version === 6) {
    migrateFromSix(db);
    version = 7;
  }
  if (version === 7) return migrateFromSeven(db);
  return false;
}

function migrateFromSeven(db: DatabaseHandle): boolean {
  db.transaction(() => {
    // Auth rows before v8 were plaintext. They cannot be safely retained without
    // an external encryption key, so force a new linked-device pairing.
    db.exec(`
      DROP TABLE auth_keys;
      DROP TABLE auth_credentials;
      CREATE TABLE auth_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL,
        registered INTEGER NOT NULL CHECK (registered IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_keys (
        category TEXT NOT NULL,
        key_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (category, key_id)
      );
    `);
  })();
  return true;
}

function scrubDeletedAuthPages(db: DatabaseHandle): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
}

function migrateFromSix(db: DatabaseHandle): void {
  db.transaction(() => {
    const columns = db.pragma("table_info(messages)") as { name: string }[];
    if (!columns.some((column) => column.name === "source_timestamp_valid")) {
      db.exec(`
        ALTER TABLE messages
        ADD COLUMN source_timestamp_valid INTEGER NOT NULL DEFAULT 0
      `);
    } else {
      db.prepare("UPDATE messages SET source_timestamp_valid = 0").run();
    }
    db.pragma("user_version = 7");
  })();
}

function migrateFromFive(db: DatabaseHandle): void {
  db.transaction(() => {
    // The send path now fetches live group metadata. Retaining participant
    // rosters serves no read contract and unnecessarily expands local data.
    db.prepare("DELETE FROM groups").run();
    db.pragma("user_version = 6");
  })();
}

function migrateFromFour(db: DatabaseHandle): void {
  db.transaction(() => {
    // Older v4 builds retained broader protocol envelopes and message-supplied
    // media URLs. Fail closed; normal on-demand sync repopulates safe records.
    db.prepare("UPDATE chats SET raw_json = NULL").run();
    db.prepare("UPDATE messages SET raw_json = NULL").run();
    db.pragma("user_version = 5");
  })();
}

function migrateFromThree(db: DatabaseHandle): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_clear_tombstones (
        transport_chat_jid TEXT PRIMARY KEY,
        cleared_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_clear_tombstones_age_idx
        ON chat_clear_tombstones(cleared_at);
    `);
    db.prepare("UPDATE chats SET raw_json = NULL").run();
    db.prepare("UPDATE messages SET raw_json = NULL").run();
    db.pragma("user_version = 4");
  })();
}

function migrateFromTwo(db: DatabaseHandle): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_tombstones (
        transport_chat_jid TEXT NOT NULL,
        source_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (transport_chat_jid, source_id)
      );
      CREATE INDEX IF NOT EXISTS message_tombstones_age_idx
        ON message_tombstones(deleted_at);
    `);
    db.prepare(`
      UPDATE messages SET timestamp = updated_at
      WHERE timestamp <= 0 OR timestamp > updated_at + 300000
    `).run();
    db.prepare(`
      UPDATE chats SET last_message_at = updated_at
      WHERE last_message_at <= 0 OR last_message_at > updated_at + 300000
    `).run();
    db.pragma("user_version = 3");
  })();
}
