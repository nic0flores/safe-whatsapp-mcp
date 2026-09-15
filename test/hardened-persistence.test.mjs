import test from "node:test";
import assert from "node:assert/strict";
import { DirectChatAllowlist } from "../dist/security/chatAllowlist.js";
import { HardenedMessageStore } from "../dist/security/hardenedMessageStore.js";
import { scrubNonAllowlistedPersistence } from "../dist/security/persistencePrivacy.js";
import { IdentityStore } from "../dist/messages/identityStore.js";
import { MessageStore } from "../dist/messages/messageStore.js";
import { directMessage, runtimeConfig, temporaryState } from "./core-helpers.mjs";

const allowedE164 = "+56911111111";
const allowedJid = "56911111111@s.whatsapp.net";
const deniedJid = "56922222222@s.whatsapp.net";
const allowedLid = "111111111111@lid";

function allowlist() {
  return DirectChatAllowlist.fromEnvironment({
    SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164: allowedE164,
  });
}

test("hardened persistence drops denied direct chats, unresolved LIDs, and groups before SQLite", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const store = new HardenedMessageStore(fixture.state, identities, runtimeConfig, allowlist());
    store.ingestHistory({
      lidPnMappings: [{ lid: allowedLid, pn: allowedJid }],
      contacts: [
        { id: allowedJid, notify: "Allowed" },
        { id: deniedJid, notify: "Denied" },
        { id: "999999999999@lid", notify: "Unknown LID" },
      ],
      chats: [
        { id: allowedJid, name: "Allowed" },
        { id: deniedJid, name: "Denied" },
        { id: "999999999999@lid", name: "Unknown LID" },
        { id: "120363000000000000@g.us", name: "Private group" },
      ],
      messages: [
        directMessage({ id: "allowed-1", jid: allowedJid, text: "keep me" }),
        directMessage({ id: "denied-1", jid: deniedJid, text: "drop me" }),
        directMessage({ id: "unknown-lid-1", jid: "999999999999@lid", text: "drop lid" }),
        directMessage({ id: "allowed-lid-1", jid: allowedLid, text: "keep mapped lid" }),
      ],
    });

    const chats = fixture.state.db.prepare(
      "SELECT transport_jid FROM chats ORDER BY transport_jid",
    ).all().map((row) => row.transport_jid);
    assert.deepEqual(chats, [allowedJid, allowedLid].sort());

    const texts = fixture.state.db.prepare(
      "SELECT text FROM messages ORDER BY text",
    ).all().map((row) => row.text);
    assert.deepEqual(texts, ["keep mapped lid", "keep me"]);

    const e164s = fixture.state.db.prepare(
      "SELECT e164 FROM identities WHERE e164 IS NOT NULL ORDER BY e164",
    ).all().map((row) => row.e164);
    assert.deepEqual(e164s, [allowedE164]);
    assert.equal(JSON.stringify(fixture.state.counts()).includes("Denied"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("legacy scrub removes non-allowlisted cached chats, identities, and tombstones", async () => {
  const fixture = await temporaryState();
  try {
    const identities = new IdentityStore(fixture.state);
    const legacy = new MessageStore(fixture.state, identities, runtimeConfig);
    legacy.ingestUpsert({
      type: "append",
      messages: [
        directMessage({ id: "allowed-old", jid: allowedJid, text: "allowed old" }),
        directMessage({ id: "denied-old", jid: deniedJid, text: "denied old" }),
      ],
    });
    fixture.state.db.prepare(`
      INSERT INTO message_tombstones (transport_chat_jid, source_id, deleted_at)
      VALUES (?, 'old-delete', ?)
    `).run(deniedJid, Date.now());

    scrubNonAllowlistedPersistence(fixture.state, allowlist());

    const chats = fixture.state.db.prepare(
      "SELECT transport_jid FROM chats ORDER BY transport_jid",
    ).all().map((row) => row.transport_jid);
    assert.deepEqual(chats, [allowedJid]);
    const messages = fixture.state.db.prepare(
      "SELECT text FROM messages ORDER BY text",
    ).all().map((row) => row.text);
    assert.deepEqual(messages, ["allowed old"]);
    const identitiesAfter = fixture.state.db.prepare(
      "SELECT e164 FROM identities WHERE e164 IS NOT NULL ORDER BY e164",
    ).all().map((row) => row.e164);
    assert.deepEqual(identitiesAfter, [allowedE164]);
    const deniedTombstone = fixture.state.db.prepare(
      "SELECT COUNT(*) AS count FROM message_tombstones WHERE transport_chat_jid = ?",
    ).get(deniedJid).count;
    assert.equal(deniedTombstone, 0);
  } finally {
    await fixture.cleanup();
  }
});
