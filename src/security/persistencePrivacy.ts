// Agent context note: Initializes the encrypted-cache epoch, scrubs legacy plaintext pages schema-agnostically while preserving only encrypted auth rows, and enforces the selected direct-chat access policy before the hardened store serves data.
import type { SqliteState } from "../storage/database.js";
import { DirectChatAllowlist } from "./chatAllowlist.js";

const ENCRYPTED_CACHE_EPOCH_KEY = "encrypted_cache_epoch";
const ENCRYPTED_CACHE_EPOCH = "1";
const AUTH_TABLES = new Set(["auth_credentials", "auth_keys"]);

export function initializeEncryptedCacheEpoch(state: SqliteState): boolean {
  const row = state.db.prepare(
    "SELECT value FROM local_meta WHERE key = ?",
  ).get(ENCRYPTED_CACHE_EPOCH_KEY) as { value: string } | undefined;
  if (row?.value === ENCRYPTED_CACHE_EPOCH) return false;

  const tables = state.db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[];

  state.db.transaction(() => {
    state.db.pragma("defer_foreign_keys = ON");
    for (const { name } of tables) {
      if (AUTH_TABLES.has(name)) continue;
      state.db.exec(`DELETE FROM ${quotedIdentifier(name)}`);
    }
  })();

  // Scrub plaintext remnants from both WAL and freed SQLite pages before the
  // epoch marker is committed. A crash before the marker safely repeats this.
  state.db.pragma("wal_checkpoint(TRUNCATE)");
  state.db.exec("VACUUM");
  state.db.pragma("wal_checkpoint(TRUNCATE)");
  state.db.prepare(`
    INSERT INTO local_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(ENCRYPTED_CACHE_EPOCH_KEY, ENCRYPTED_CACHE_EPOCH);
  state.hardenFiles();
  return true;
}

export function hasRetainedCacheRows(state: SqliteState): boolean {
  const row = state.db.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM messages
      UNION ALL SELECT 1 FROM chats
      UNION ALL SELECT 1 FROM identities
    ) AS present
  `).get() as { present: number };
  return row.present === 1;
}

export function scrubNonAllowlistedPersistence(
  state: SqliteState,
  allowlist: DirectChatAllowlist,
): void {
  state.db.transaction(() => {
    state.db.prepare("DELETE FROM groups").run();

    if (allowlist.mode === "all") {
      state.db.prepare("DELETE FROM chats WHERE kind <> 'direct'").run();
      state.db.prepare(`
        DELETE FROM identities
        WHERE id NOT IN (
          SELECT identity_id FROM chats
          WHERE kind = 'direct' AND identity_id IS NOT NULL
        )
      `).run();
      state.db.prepare(`
        DELETE FROM message_tombstones
        WHERE transport_chat_jid NOT IN (
          SELECT ia.jid
          FROM identity_aliases ia
          JOIN identities i ON i.id = ia.identity_id
        )
      `).run();
      state.db.prepare(`
        DELETE FROM chat_clear_tombstones
        WHERE transport_chat_jid NOT IN (
          SELECT ia.jid
          FROM identity_aliases ia
          JOIN identities i ON i.id = ia.identity_id
        )
      `).run();
      return;
    }

    const allowed = allowlist.values();
    if (allowed.length === 0) {
      state.db.prepare("DELETE FROM messages").run();
      state.db.prepare("DELETE FROM chats").run();
      state.db.prepare("DELETE FROM identity_aliases").run();
      state.db.prepare("DELETE FROM identities").run();
      state.db.prepare("DELETE FROM message_tombstones").run();
      state.db.prepare("DELETE FROM chat_clear_tombstones").run();
      return;
    }

    const placeholders = allowed.map(() => "?").join(", ");
    state.db.prepare(`
      DELETE FROM chats
      WHERE kind <> 'direct'
         OR identity_id IS NULL
         OR identity_id NOT IN (
           SELECT id FROM identities WHERE e164 IN (${placeholders})
         )
    `).run(...allowed);

    state.db.prepare(`
      DELETE FROM identities
      WHERE e164 IS NULL OR e164 NOT IN (${placeholders})
    `).run(...allowed);

    state.db.prepare(`
      DELETE FROM message_tombstones
      WHERE transport_chat_jid NOT IN (
        SELECT ia.jid
        FROM identity_aliases ia
        JOIN identities i ON i.id = ia.identity_id
        WHERE i.e164 IN (${placeholders})
      )
    `).run(...allowed);

    state.db.prepare(`
      DELETE FROM chat_clear_tombstones
      WHERE transport_chat_jid NOT IN (
        SELECT ia.jid
        FROM identity_aliases ia
        JOIN identities i ON i.id = ia.identity_id
        WHERE i.e164 IN (${placeholders})
      )
    `).run(...allowed);
  })();
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
