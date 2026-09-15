# Hardened read-only fork — V2 encrypted cache

This work is based on upstream commit `fe29a1e6505fdaa82d6d2003d954d07d04773d46`. V1 established a five-tool read-only MCP surface, explicit E.164 allowlisting, hard-disabled outbound behavior, and clean production dependencies. V2 moves the privacy boundary down into persistence and encrypts retained human content at rest.

## Current gate status

**CANDIDATE — DO NOT PAIR A PRIMARY WHATSAPP ACCOUNT UNTIL ALL V2 GATES ARE GREEN.**

Required before pairing:

- `HARDENED V2 ENCRYPTED CACHE WINDOWS GATE: PASS` on the target Windows machine;
- complete hardened CI green on Ubuntu and macOS, Node 22 and 24;
- `npm audit --omit=dev` reports zero known production vulnerabilities.

## Security invariants

- MCP exposes **five read-only tools only**: status, list allowed chats, read allowed chat, fetch older messages for an allowed chat, and search inside an allowed chat.
- No MCP send, draft, browser-review, media-download, media-resource, or whole-account resync tool is exposed.
- Upstream send/review internals remain compiled for compatibility, but application/runtime gates force text and media sending off and the CLI exposes no send-enabling flags.
- Only direct chats whose canonical E.164 number appears in `SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164` may reach the public read surface.
- The same allowlist is enforced **before persistence**. Groups, denied direct chats, and unresolved/unauthorized LIDs are discarded before SQLite.
- Empty/missing allowlist fails closed.
- Global message search is denied; every search requires an explicit allowlisted `chatId`.
- Default retention is 3 days and 100 messages per chat.
- The package is `private: true` and production dependencies must pass `npm audit --omit=dev` cleanly.

## Encrypted cache design

Authentication credentials and retained chat content use **independent OS credential-store keys**.

- WhatsApp auth: AES-256-GCM using the upstream credential vault.
- Cache content: AES-256-GCM using a separate cache vault and a separate HKDF domain (`safe-whatsapp-mcp/cache-encryption/v1`).
- Cache envelopes use fresh 96-bit nonces and 128-bit authentication tags.
- AAD binds encrypted content to its field and stable identity/message identifier so ciphertext cannot be freely moved between records.
- Human-readable identity names, message text/captions, and retained filenames are encrypted before they reach SQLite.
- Direct-chat names are stored once as encrypted identity display names rather than duplicated as plaintext chat titles.
- Downloadable-media capabilities (`directPath`, `mediaKey`, URL) are removed before persistence in hardened read-only mode.
- E.164 numbers, normalized WhatsApp JIDs, opaque IDs, timestamps, and bounded non-human media metadata remain plaintext because they are required for allowlisting, pagination, deletion, and retention.
- Search over encrypted messages is performed only inside one allowlisted chat by decrypting the bounded retained set in memory.

## Plaintext-cache migration

The first V2 encrypted-cache open establishes `encrypted_cache_epoch=1`.

Before that marker is written, V2:

1. preserves only the already-encrypted auth tables (`auth_credentials`, `auth_keys`);
2. empties every other local SQLite table, including unknown/future state tables;
3. checkpoints the WAL;
4. runs `VACUUM` to scrub freed plaintext pages;
5. checkpoints again;
6. writes the encrypted-cache epoch marker; and
7. creates a separate cache-vault key in the OS credential store.

A crash before the epoch marker safely repeats the scrub on the next start. V2 does not attempt to re-encrypt legacy plaintext cache rows in place.

## Allowlist

Set a comma-separated canonical E.164 list before starting the MCP server, for example:

```text
SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164=+56911111111,+56922222222
```

Do not use display names or group IDs.

## Verification

Windows:

```powershell
.\scripts\verify-hardened-windows.ps1
```

The fail-closed Windows gate performs `npm ci`, typecheck, build, hardened allowlist/persistence/cache-encryption tests, production dependency audit, and an explicit forbidden-tool scan.

`.github/workflows/hardened-ci.yml` independently runs the complete suite and production audit on Ubuntu/macOS with Node 22 and 24, plus a dedicated encrypted-persistence invariant job.

## Residual risks

1. **Baileys remains unofficial.** No code hardening can remove WhatsApp/Meta account-policy or protocol-change risk. A secondary-number trial remains prudent before using a primary account.
2. **Legacy outbound implementation remains compiled.** It is unreachable from the hardened MCP/CLI and runtime gates are forced off, but a later V3 could physically delete those modules to reduce code surface further.
3. **Metadata remains plaintext by design.** E.164/JIDs, timestamps, IDs and limited media metadata are not content-encrypted. Full-disk encryption such as BitLocker is still recommended as defense in depth.
4. **At-rest encryption does not protect an unlocked compromised host.** A process running as the user may be able to access the OS credential store and decrypt the local cache.
