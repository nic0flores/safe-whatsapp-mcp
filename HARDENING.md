# Hardened read-only fork — V1

This branch is pinned to upstream commit `fe29a1e6505fdaa82d6d2003d954d07d04773d46` and intentionally narrows the original project before it is paired with a primary personal WhatsApp account.

## Current gate status

**NOT READY FOR PRIMARY WHATSAPP PAIRING.**

The first Windows bootstrap incorrectly continued after native commands returned non-zero exit codes. That defect is now addressed by `scripts/verify-hardened-windows.ps1`, which checks every native exit code explicitly. The remaining dependency audit findings must be repaired and the hardened gate must print `HARDENED V1 WINDOWS GATE: PASS` before pairing.

## Security invariants

- MCP exposes **five read-only tools only**: status, list allowed chats, read allowed chat, fetch older messages for an allowed chat, and search inside an allowed chat.
- No MCP send, draft, browser-review, media-download, media-resource, or resync tool is exposed.
- Upstream send/review services remain compiled in V1 for a smaller patch, but both the application and runtime config hard-disable text and media sending regardless of environment flags.
- The CLI exposes no `--enable-send` or `--enable-media-send` path.
- Only direct chats whose canonical E.164 number appears in `SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164` are returned or readable.
- Groups are denied in V1.
- Global message search is denied; every search requires an explicit allowlisted `chatId`.
- Empty/missing allowlist fails closed.
- Default local retention is reduced to 3 days and 100 messages per chat.
- The package is marked `private: true` to prevent accidental npm publication.
- Production dependencies must pass `npm audit --omit=dev` with zero known vulnerabilities.

## Important residual risks

1. The upstream send/review implementation still exists in the binary, although V1 makes it unreachable from MCP and forces its runtime gates off. V2 should delete that code path entirely.
2. Baileys is still an unofficial WhatsApp linked-device implementation. This fork cannot remove WhatsApp account-policy risk.
3. Message text in the upstream SQLite cache remains plaintext in V1. Use full-disk encryption (BitLocker/FileVault/LUKS) and do **not** pair a primary account yet. Cache encryption is a separate V2 change so it can be reviewed independently.
4. Recent WhatsApp synchronization may still ingest non-allowlisted account data into the local upstream cache even though MCP cannot expose it. V2 should move filtering/encryption down to persistence.

## Allowlist

Set a comma-separated list before launching the MCP server, for example:

```text
SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164=+56911111111,+56922222222
```

Use canonical E.164 only. Do not use display names.

## Windows repair + verification

From the checked-out `hardening/read-only-v1` branch:

```powershell
.\scripts\repair-security-deps-windows.ps1
```

The repair script:

1. fast-forwards the local branch from GitHub;
2. pins `sharp` to `0.35.4` and overrides `qs` to `^6.16.0`;
3. regenerates `npm-shrinkwrap.json` without running package scripts;
4. runs the fail-closed Windows hardening gate;
5. commits and pushes the dependency repair only if every gate succeeds.

The Windows gate includes typecheck, build, hardened security tests, production dependency audit, and an explicit forbidden-tool scan.

## Full-suite CI

`.github/workflows/hardened-ci.yml` runs the complete upstream test suite plus the production audit on Linux and macOS, along with a dedicated hardening-surface job. Treat V1 as verified only after those jobs are green as well.
