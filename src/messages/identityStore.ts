// Agent context note: Maintains opaque people plus canonical bounded machine-derived PN/LID aliases. Tests: test/core-identity-messages.test.mjs. Never infer identity from display names, message text, or malformed phone JIDs; update this note after meaningful changes.
import { randomUUID } from "node:crypto";
import type { SqliteState } from "../storage/database.js";
import { SafeWhatsAppError } from "../errors.js";

export type IdentityAliasKind = "pn" | "lid";

export interface IdentityRecord {
  id: string;
  e164?: string;
  displayName?: string;
  aliases: { jid: string; kind: IdentityAliasKind }[];
}

export interface ObservedIdentity {
  jid: string;
  pairedJid?: string;
  e164?: string;
  displayName?: string;
}

export class IdentityStore {
  constructor(private readonly state: SqliteState) {}

  observe(input: ObservedIdentity): IdentityRecord {
    const aliases = [normalizeUserJid(input.jid)];
    if (input.pairedJid) aliases.push(normalizeUserJid(input.pairedJid));
    const e164 = input.e164
      ? normalizeE164(input.e164)
      : aliases.map(e164FromPhoneJid).find(Boolean);
    const ids = new Set<string>();
    let e164Owner: string | undefined;
    const aliasQuery = this.state.db.prepare(
      "SELECT identity_id FROM identity_aliases WHERE jid = ?",
    );
    for (const alias of aliases) {
      const row = aliasQuery.get(alias) as { identity_id: string } | undefined;
      if (row) ids.add(row.identity_id);
    }
    if (e164) {
      const row = this.state.db
        .prepare("SELECT id FROM identities WHERE e164 = ?")
        .get(e164) as { id: string } | undefined;
      if (row) {
        ids.add(row.id);
        e164Owner = row.id;
      }
    }
    const id = e164Owner ?? [...ids].sort()[0] ?? randomUUID();
    const now = Date.now();
    this.state.db.transaction(() => {
      this.state.db.prepare(`
        INSERT INTO identities (id, e164, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          e164 = COALESCE(excluded.e164, identities.e164),
          display_name = COALESCE(excluded.display_name, identities.display_name),
          updated_at = excluded.updated_at
      `).run(id, e164 ?? null, cleanName(input.displayName), now, now);
      for (const duplicate of ids) {
        if (duplicate !== id) this.merge(duplicate, id);
      }
      const upsertAlias = this.state.db.prepare(`
        INSERT INTO identity_aliases (jid, identity_id, kind, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          identity_id = excluded.identity_id,
          kind = excluded.kind,
          last_seen_at = excluded.last_seen_at
      `);
      for (const alias of aliases) upsertAlias.run(alias, id, aliasKind(alias), now);
      if (e164) {
        this.state.db.prepare(`
          UPDATE messages SET sender_e164 = ?, updated_at = ?
          WHERE sender_identity_id = ? AND sender_e164 IS NULL
        `).run(e164, now, id);
      }
    })();
    return this.get(id)!;
  }

  linkLid(lid: string, phone: string): IdentityRecord {
    return this.observe({ jid: lid, pairedJid: phone });
  }

  get(id: string): IdentityRecord | undefined {
    const row = this.state.db
      .prepare("SELECT id, e164, display_name FROM identities WHERE id = ?")
      .get(id) as { id: string; e164: string | null; display_name: string | null } | undefined;
    if (!row) return undefined;
    const aliases = this.state.db
      .prepare("SELECT jid, kind FROM identity_aliases WHERE identity_id = ? ORDER BY kind, jid")
      .all(id) as { jid: string; kind: IdentityAliasKind }[];
    return {
      id: row.id,
      ...(row.e164 ? { e164: row.e164 } : {}),
      ...(row.display_name ? { displayName: row.display_name } : {}),
      aliases,
    };
  }

  findByJid(jid: string): IdentityRecord | undefined {
    const row = this.state.db
      .prepare("SELECT identity_id FROM identity_aliases WHERE jid = ?")
      .get(normalizeUserJid(jid)) as { identity_id: string } | undefined;
    return row ? this.get(row.identity_id) : undefined;
  }

  findByE164(e164: string): IdentityRecord | undefined {
    const row = this.state.db
      .prepare("SELECT id FROM identities WHERE e164 = ?")
      .get(normalizeE164(e164)) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }

  private merge(fromId: string, toId: string): void {
    const source = this.state.db
      .prepare("SELECT e164, display_name FROM identities WHERE id = ?")
      .get(fromId) as { e164: string | null; display_name: string | null } | undefined;
    if (!source) return;
    this.state.db.prepare(`
      UPDATE identities SET
        e164 = COALESCE(e164, ?),
        display_name = COALESCE(display_name, ?),
        updated_at = ?
      WHERE id = ?
    `).run(source.e164, source.display_name, Date.now(), toId);
    this.state.db.prepare("UPDATE identity_aliases SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
    this.state.db.prepare("UPDATE chats SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
    this.state.db.prepare("UPDATE messages SET sender_identity_id = ? WHERE sender_identity_id = ?").run(toId, fromId);
    this.state.db.prepare("DELETE FROM identities WHERE id = ?").run(fromId);
  }
}

export function normalizeE164(value: string): string {
  const normalized = value.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new SafeWhatsAppError("Phone destination must use canonical +E.164 format.", "invalid_destination");
  }
  return normalized;
}

export function normalizeUserJid(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^(\d+):\d+@(s\.whatsapp\.net|lid)$/, "$1@$2");
  if (normalized.length > 128 || !/^\d+@(s\.whatsapp\.net|lid)$/.test(normalized)) {
    throw new SafeWhatsAppError("WhatsApp identity metadata contained an invalid user JID.", "invalid_identity");
  }
  return normalized;
}

export function e164FromPhoneJid(jid: string): string | undefined {
  const match = /^([1-9]\d{6,14})@s\.whatsapp\.net$/.exec(jid);
  return match ? `+${match[1]}` : undefined;
}

function aliasKind(jid: string): IdentityAliasKind {
  return jid.endsWith("@lid") ? "lid" : "pn";
}

function cleanName(value: string | undefined): string | null {
  const clean = value?.trim();
  return clean ? clean.slice(0, 256) : null;
}
