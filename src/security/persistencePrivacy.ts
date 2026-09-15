// Agent context note: Scrubs legacy cached WhatsApp state so only explicitly allowlisted direct-chat identities and their rows remain before the hardened store starts serving data.
import type { SqliteState } from "../storage/database.js";
import { DirectChatAllowlist } from "./chatAllowlist.js";

export function scrubNonAllowlistedPersistence(
  state: SqliteState,
  allowlist: DirectChatAllowlist,
): void {
  const allowed = allowlist.values();
  state.db.transaction(() => {
    state.db.prepare("DELETE FROM groups").run();

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
