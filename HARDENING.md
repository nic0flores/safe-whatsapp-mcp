# Hardened read-only fork — V1

This branch is pinned to upstream commit `fe29a1e6505fdaa82d6d2003d954d07d04773d46` and intentionally narrows the original project before it is paired with a primary personal WhatsApp account.

## Security invariants

- MCP exposes **five read-only tools only**: status, list allowed chats, read allowed chat, fetch older messages for an allowed chat, and search inside an allowed chat.
- No MCP send, draft, browser-review, media-download, media-resource, or resync tool is exposed.
- Upstream send/review services remain compiled in V1 for a smaller patch, but the application hard-disables both text and media sending regardless of environment flags.
- Only direct chats whose canonical E.164 number appears in `SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164` are returned or readable.
- Groups are denied in V1.
- Global message search is denied; every search requires an explicit allowlisted `chatId`.
- Empty/missing allowlist fails closed.
- Default local retention is reduced to 3 days and 100 messages per chat.
- The package is marked `private: true` to prevent accidental npm publication.
- Production overrides require patched `fast-uri` (3.1.7+) and Hono (4.13.7+). The bootstrap must still finish with `npm audit --omit=dev` clean before pairing.

## Important residual risks

1. The upstream send/review implementation still exists in the binary, although V1 makes it unreachable from MCP and forces its runtime gates off. V2 should delete that code path entirely.
2. Baileys is still an unofficial WhatsApp linked-device implementation. This fork cannot remove WhatsApp account-policy risk.
3. Message text in the upstream SQLite cache remains plaintext in V1. Use full-disk encryption (BitLocker/FileVault/LUKS) and do **not** pair a primary account until the V1 verification gate passes. Cache encryption is a separate V2 change so it can be reviewed independently.
4. Recent WhatsApp synchronization may still ingest non-allowlisted account data into the local upstream cache even though MCP cannot expose it. V2 should move filtering/encryption down to persistence.

## Allowlist

Set a comma-separated list before launching the MCP server, for example:

```text
SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164=+56911111111,+56922222222
```

Use canonical E.164 only. Do not use display names.

## V1 verification gate

Do not pair WhatsApp unless all of these succeed on the target machine:

```text
npm install --package-lock-only --ignore-scripts
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

The last command must report zero known production vulnerabilities.
