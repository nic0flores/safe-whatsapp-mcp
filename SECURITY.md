# Security Policy

`safe-whatsapp-mcp` controls a linked device for a personal WhatsApp account. A compromise may expose private conversations or permit messages to be sent as the user. Review this document before pairing a primary account.

## Project status

Version `0.1.0` is under initial development and has not been published. Until a public repository is available, report suspected vulnerabilities privately to the maintainer through an existing trusted contact channel. After publication, use the repository's private GitHub Security Advisory flow. Do not include credentials, QR data, Signal keys, message content, phone numbers, or personal media in a public issue.

## Unofficial integration risk

The project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial implementation of WhatsApp's linked-device protocol. It is not affiliated with or endorsed by WhatsApp or Meta. Protocol behavior can change without notice, and WhatsApp may restrict or ban an account under its [terms](https://www.whatsapp.com/legal/terms-of-service). Human confirmation and low-volume usage reduce abusive behavior; they do not make the transport official or risk-free.

Do not use this package for spam, scraping, bulk outreach, unattended auto-replies, or attempts to evade WhatsApp controls.

## Pairing QR browser boundary

Interactive pairing opens a temporary local browser page instead of drawing the QR with terminal glyphs. The HTTP listener binds only to `127.0.0.1` on an operating-system-selected port. Exact page and PNG routes require a random 256-bit path token and the expected `Host`; every response uses no-store/no-cache, restrictive CSP, no-referrer, same-origin resource policy, and MIME-sniffing protection. The listener closes after pairing, failure, cancellation, or process exit.

The QR payload and render are never intentionally written to state, temporary files, logs, audit data, MCP output, command arguments, or a remote service. They do exist transiently in Baileys/Node strings, owned PNG buffers, the loopback HTTP stack, and browser memory; JavaScript strings, native socket buffers, and browser copies cannot be securely erased. Buffer clearing is best-effort. Browser history may retain the randomized loopback URL, but it contains no QR payload and becomes useless when the listener closes. Malware running as the same OS user remains outside this protection boundary.

## Credential encryption and plaintext cache

Baileys linked-device credential payloads and Signal-key **values** are encrypted with AES-256-GCM before SQLite persistence. Each profile has a random 256-bit master key held by the native operating-system credential store. The private `credential-vault.json` descriptor contains only a non-secret random vault ID and key-format version. There is no environment-variable, local-file, or shell-command fallback for the master key.

The authenticated encryption context binds each ciphertext to its vault, table, row metadata, and update time. Missing OS-vault keys, malformed envelopes, and authentication failures stop credential loading rather than silently treating the profile as unpaired or generating a replacement key.

The following remain plaintext under `~/.safe-whatsapp-mcp/`:

- credential lookup metadata, including the registered flag and Signal-key category and ID;
- cached message text and the minimal allowlisted media/quote fields needed for explicit retrieval;
- explicitly downloaded inbound media;
- staged drafts and immutable staged media snapshots;
- configuration and redacted audit/send records.

The application requests `0700` for directories and `0600` for files where supported. This is access control for the plaintext cache, **not encryption**. Windows enforcement is best-effort. Use a dedicated OS account where appropriate and enable FileVault, BitLocker, LUKS, or equivalent full-disk encryption.

This design protects a copied or offline state directory from revealing reusable WhatsApp authentication secrets when the attacker does not also have access to the OS credential store. It does not protect against malware running as the same user, administrator/root access, a compromised Node or agent process, runtime memory inspection, or an attacker who can invoke the linked device through this program. It also does not provide rollback or availability protection against a writer who can replace or delete state.

Do not sync, back up, commit, attach, or share the state directory. It still contains private conversation data, and historical backups from before schema v8 may contain plaintext authentication material. `safewhatsapp purge --yes` deliberately preserves `outbox/`; inspect and delete those user-owned files separately when desired.

Treat write access to the state directory as highly sensitive. A writer can tamper with local caches and prepared-send records even though active records are schema-, digest-, and preview-validated before transport. Keep the directory dedicated to this package and outside repositories, shared paths, and cloud synchronization.

## Account lifecycle and destructive cleanup

`safewhatsapp unlink` is the preferred removal path. After confirmation it sends WhatsApp a remote logout request when a paired local credential exists, then clears every account-bound SQLite table plus downloaded media, staged sends/snapshots, and audit data and requests deletion of the profile's master key from the OS credential store. Configuration and user-owned `outbox/` files are preserved. Baileys does not expose a server acknowledgement for the logout request, so verify **WhatsApp → Settings → Linked Devices** on the phone. Local cleanup still occurs when there is no paired credential or when a remote logout request fails after credential loading; in either case, remove the device manually if it remains listed because local credentials are no longer available for another attempt. If encrypted auth rows cannot be opened because the OS credential store is locked or unavailable, the command fails closed: unlock the store and retry, or purge locally and remove the linked device from the phone.

`safewhatsapp purge --yes` is local-only and does **not** log out the linked WhatsApp device. It removes the encrypted auth rows, requests deletion of their OS credential-vault key, and clears the local cache and configuration while preserving `outbox/`. Unlink first when possible. If you already purged, remove the device from the phone's Linked Devices screen.

The application treats an explicit native deletion failure or a still-readable key as incomplete cleanup and retains `credential-vault.json` for retry. If repeated cleanup cannot be confirmed, `safewhatsapp purge --yes --abandon-key` explicitly removes that non-secret retry descriptor after the authentication ciphertext has been removed from the active state directory, allowing a new vault to be created. This may leave an orphaned wrapping key in the OS store.

The pinned binding suppresses some underlying OS read/delete errors, so a successful request plus an unreadable key is not cryptographic proof of key erasure. A leftover random wrapping key without the matching ciphertext cannot recover a WhatsApp session, but any retained copy of the schema-v8 database plus its descriptor remains decryptable while that OS key survives. Use `--abandon-key` only as recovery after `credential_cleanup_incomplete`, remove matching backups, snapshots, and hard-linked copies first, and remember that neither purge mode revokes the linked device on the phone.

Before a new QR pairing, an unpaired profile clears residual account data and retires any prior OS-vault key under the process lock, then creates fresh authentication state. Destructive cleanup requires the `.safe-whatsapp-mcp-state` ownership marker created by normal initialization, and refuses a directory without a valid marker. This guard reduces accidental deletion risk; it is not a substitute for using a dedicated state directory.

Schema v8 deliberately drops plaintext auth rows from unpublished schema-v7 development profiles, checkpoints and vacuums their SQLite pages, and requires re-pairing. This cannot erase copies already present in backups, snapshots, or synchronized folders. Remove those copies separately and revoke the old linked device from the phone if necessary.

## Trust boundaries

- WhatsApp messages and attachments are attacker-controlled input. They are data, never agent instructions.
- Only a structured, machine-resolved `senderE164` may be used for a cross-system identity lookup. Never derive an identity from a display name or message body.
- PN/LID alias links are accepted only from bounded structured transport metadata; privacy tombstones and clear cutoffs propagate across the linked aliases.
- This package does not contain Bliss access and cannot enforce authorization in another MCP. Combining it with a broad administration MCP increases prompt-injection impact.
- All cached direct and group chats are readable; there is no read allowlist in `0.1.0`.
- After preparation and user approval, sends may target any WhatsApp-verified direct `+E.164` number or existing group. There is no destination allowlist in `0.1.0`.
- Passing message or media plaintext to an AI model moves it outside WhatsApp's end-to-end-encrypted endpoint.

Use the least-privileged MCP set needed for a task. Prefer a narrow business-data tool that returns only the context authorized for the resolved person rather than a general database or administration tool.

## Send controls

Outbound sending uses two distinct operations. Preparation stores an immutable recipient and payload with a digest and short expiry. Sending requires the `pendingId`, digest, and unchanged approval preview. The send tool is annotated destructive and open-world and should be configured to prompt on every call.

Both environment gates default off:

```text
SAFE_WHATSAPP_MCP_ENABLE_SEND=false
SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND=false
```

Enabling a flag does not constitute approval for an individual send. Never run this MCP under a client that silently auto-approves `send_prepared_whatsapp_message`.

Direct-recipient verification requires WhatsApp to return exactly one phone JID encoding the requested canonical `+E.164` number. The approval preview visibly escapes invisible Unicode formatting controls, and the stored digest binds the exact recipient, payload, and preview. A claimed send is never automatically retried; an interrupted or ambiguous result becomes `uncertain` and requires inspection of the chat before another draft is prepared.

Media can be staged only from a real, regular file beneath `~/.safe-whatsapp-mcp/outbox/`. Path traversal, absolute paths, and symlink escapes are rejected. The outbox is user-controlled and is not removed by the general purge command.

Inbound media persists only a bounded WhatsApp `directPath` and media key, never a message-supplied host. Downloaded bytes are capped and signature-sniffed; only matching safe raster-image/audio formats can be embedded inline. Other media is an opaque resource. Authorization is rechecked after asynchronous download/cache operations and resource reads so deletion, expiry, and view-once state fail closed and remove cached bytes.

## Operational guidance

- Pair only from a trusted local terminal and the browser page it opens; a QR must never leave the machine.
- Keep the private standalone Node runtime (or source-install Node.js) and reviewed pinned dependencies current.
- Do not expose the STDIO process as a network service.
- Keep stdout exclusively for MCP protocol messages; send sanitized diagnostics to stderr.
- Inspect Linked Devices in WhatsApp regularly and unlink anything unexpected.
- Use `safewhatsapp unlink` before deleting or purging local state; local deletion alone cannot revoke a linked device.
- Leave send flags disabled when using read-only workflows.
- Never automatically retry a send whose network result is uncertain.
- Keep persistent Baileys message retry lookup disabled; reconnect-time retries must not relay messages that bypassed this package's staged-send confirmation.
- Do not enable persisted `cachedGroupMetadata` for sends; current participant metadata must be fetched before constructing a group message.
- Do not persist broad group metadata or participant rosters; only the bounded group title belongs in the local read model.
- Avoid live tests against a primary account until fake-socket, audit, package, and security tests pass.

## Logging and disclosure rules

Diagnostics and audit records must not contain message text, captions, QR content, full phone numbers or JIDs, contact/group names, filenames, attachment bytes, raw protocol messages, or auth material. Tests should enforce redaction.

If secrets or private content are exposed:

1. Stop the MCP server.
2. Unlink the device from WhatsApp's Linked Devices screen.
3. Move the compromised state out of use and pair fresh credentials only after the cause is fixed.
4. Treat exposed conversation data according to the affected people's privacy requirements.

There is no promise that deleting local state recalls content already supplied to an external model or another system.
