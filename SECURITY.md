# Security Policy

`safe-whatsapp-mcp` controls a linked device for a personal WhatsApp account. A compromise may expose private conversations or permit messages to be sent as the user. Review this document before pairing a primary account.

## Project context

Safe WhatsApp MCP was initially built for a personal [Bliss AI](https://www.meditatewithbliss.com/) workflow. Much of the implementation was AI-assisted, and it has not received an independent security audit. Security-minded review is welcome, but the project should still be treated as experimental.

## Supported versions

Version `0.2.3` is the current supported source release. Security fixes target the current `0.2.x` release and `main`. There are no signed standalone release downloads yet.

## Reporting vulnerabilities

Please report suspected vulnerabilities privately through [GitHub's security advisory flow](https://github.com/dhruvratra/safe-whatsapp-mcp/security/advisories/new). If that flow is unavailable, contact the maintainer through an existing trusted private channel. Do not open a public issue for an unpatched vulnerability.

Include:

- the affected version or commit;
- the impact and affected security boundary;
- minimal reproduction steps using synthetic data; and
- whether credentials, messages, phone numbers, recipient data, or media may be exposed.

Never include real credentials, QR data, Signal keys, message content, phone numbers, contact or group names, or personal media in a report.

## Response expectations

The maintainer aims to acknowledge reports within five business days, triage severity, and provide a fix or mitigation plan when an issue is confirmed. Please allow a reasonable remediation window before public disclosure.

## Unofficial integration risk

The project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial implementation of WhatsApp's linked-device protocol. It is not affiliated with or endorsed by WhatsApp or Meta. Protocol behavior can change without notice, and WhatsApp may restrict or ban an account under its [terms](https://www.whatsapp.com/legal/terms-of-service). Human confirmation and low-volume usage reduce abusive behavior; they do not make the transport official or risk-free.

Do not use this package for spam, scraping, bulk outreach, unattended auto-replies, or attempts to evade WhatsApp controls.

## Pairing QR browser boundary

Interactive pairing opens a temporary local browser page instead of drawing the QR with terminal glyphs. The HTTP listener binds only to `127.0.0.1` on an operating-system-selected port. Exact page and PNG routes require a random 256-bit path token and the expected `Host`; every response uses no-store/no-cache, restrictive CSP, no-referrer, same-origin resource policy, and MIME-sniffing protection. The listener closes after pairing, failure, cancellation, or process exit.

The QR payload and render are never intentionally written to state, temporary files, logs, audit data, MCP output, command arguments, or a remote service. They do exist transiently in Baileys/Node strings, owned PNG buffers, the loopback HTTP stack, and browser memory; JavaScript strings, native socket buffers, and browser copies cannot be securely erased. Buffer clearing is best-effort. Browser history may retain the randomized loopback URL, but it contains no QR payload and becomes useless when the listener closes. Malware running as the same OS user remains outside this protection boundary.

## Send-review browser boundary

`open_whatsapp_send_review` is deliberately non-destructive: it validates a draft, snapshots any initial outbox attachment, opens a private local page, and returns. It cannot call the WhatsApp transport. The later **Send on WhatsApp** button freezes the page's edited recipient, text/caption, reply context, attachment, and link card and invokes an internal single-use send path that is not exposed as an MCP tool.

The broker owns one lazy HTTP listener on `127.0.0.1` with an operating-system-selected port. Each review receives a separate 256-bit route token and a second 256-bit action token. The action token is delivered only in the URL fragment, moved to per-tab session storage, and removed from browser history before any mutation. MCP results contain only the review ID, expiry, state, and successful-open flag; they never contain the URL, route token, action token, broker secret, message content, or attachment path.

Every mutation requires the exact loopback peer, exact `Host` and `Origin`, a same-origin fetch context when supplied by the browser, and the action token in a custom header. There is no CORS or `OPTIONS` allowance. Methods, JSON keys, filenames, and body sizes are bounded. Responses use no-store, no-referrer, MIME-sniffing protection, same-origin isolation, a restrictive Permissions Policy, and CSP that permits only same-origin script, style, image, media, and fetch resources. User data is fetched as JSON and assigned through DOM text/value properties; it is never interpolated into HTML.

Once Send is accepted, the page locks immediately and shows a sending indicator until a terminal result is known. The receipt is built from a frozen, capability-free summary captured before transport—not from later editable state. It may contain the reviewed recipient label, exact text/caption, reply label, attachment filename/type/size/kind, reviewed link-card display data, and completion time. It never contains route/action secrets, raw chat or message IDs, opaque revision IDs, JIDs, media paths, hashes, thumbnail bytes, or transport IDs. Terminal state rotates the server-side action capability and the page removes its session-storage copy.

The page shows the canonical linked sending number when it can be derived from the encrypted Baileys account credentials and otherwise labels the number unavailable instead of guessing. Direct recipients are reverified as canonical `+E.164`; group edits can select only review-scoped opaque choices mapped to locally named cached groups, with a stable masked identifier visible beside every escaped title. Unknown or unnamed selected groups fail closed. Reply reviews resolve the retained target locally and expose an escaped sender/time/snippet/reference summary; a missing or cross-chat target fails before the page opens. Replacement attachments arrive only through an explicit browser file picker and bounded upload, are signature-sniffed and hash-bound, and cannot name another filesystem path. A random attachment revision is bound into the final browser request, and review mutations are serialized, so another tab cannot replace or remove media after it was visually approved. Double clicks and replay produce at most one transport attempt. Closing, cancelling, expiry, browser-launch failure, broker shutdown, and terminal cleanup remove unsent review media. If transport has started, shutdown waits for its bounded outcome and never retries an uncertain result.

The first HTTP(S) or `www.` URL in a text-only draft is fetched automatically, which discloses the user's public IP address to that site. Adding a file prevents preview fetching, and removing the card suppresses it without changing the message. The fetcher permits only ports 80/443, rejects credentials and any mixed/private/reserved/loopback/link-local DNS answer, pins a validated address, repeats validation on every redirect, sends no cookies/auth/referrer, and caps redirects, time, HTML, and image bytes. Accepted raster artwork is re-encoded to a small JPEG and served locally; remote image URLs never enter the page. The exact reviewed card is passed to Baileys, or preview generation is explicitly disabled, preventing a different transport-time fetch.

A browser click is not cryptographic proof of human presence. The boundary holds only while the AI agent cannot control the user's system browser. Do not combine Safe WhatsApp with browser, desktop, accessibility, or computer-control automation that can operate the review page. Stronger assurance would require a separate authenticator such as WebAuthn/Touch ID or retaining an MCP confirmation prompt.

## Shared local broker boundary

Every `safewhatsapp serve` process is a per-client STDIO proxy. Proxies converge on one ephemeral broker bound only to `127.0.0.1` on an operating-system-selected port. The broker is the sole owner of the process lock, SQLite database, native credential-vault access, and on-demand Baileys session. Each authenticated proxy receives a separate MCP connection backed by those shared services, so one proxy closing does not close another client's session.

The private `broker.json` descriptor is requested as mode `0600` where supported. It contains bounded coordination metadata and a random, short-lived local IPC capability; it does **not** contain WhatsApp credentials, Signal keys, message content, or the credential-vault master key. Authentication proves possession of that capability before MCP bytes are accepted. The capability expires with the broker and the descriptor is removed when the broker stops.

Admission fails closed unless a proxy matches the broker's exact package version, configuration fingerprint, and text/media send gates. This prevents a read-only client from silently inheriting a send-enabled broker. Close and restart all Safe WhatsApp Codex clients after changing the configuration, either send gate, or the installed package/bundle. Commands requiring exclusive profile access—`connect`, `disconnect`, and `purge`—use a separate capability-authenticated shutdown purpose. The broker rejects unauthenticated handoffs, stops accepting work, drains tracked operations, closes attached MCP connections, and releases SQLite before the command proceeds. This broker handoff never logs out WhatsApp; only the subsequent explicit `disconnect` operation does.

The local `status` command may authenticate using the running descriptor's policy so a terminal without Codex's send environment can inspect that broker. This reviewed path invokes only status and, with `--live`, the existing bounded synchronization read; it does not expose a policy-independent MCP connection to agents.

The broker exists only while clients or browser reviews are active. An open review keeps it alive after the initiating MCP proxy disconnects; terminal state remains available briefly and then the review capability is destroyed. The WhatsApp socket still connects only on tool demand and closes after the configured idle period, 60 seconds by default; broker shutdown never logs out the linked device. The loopback authentication and private file mode reduce accidental cross-process access, but they do not defend against malware running as the same OS user, administrator/root access, runtime memory inspection, or a compromised MCP client that can read the state directory or invoke the proxy.

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

`safewhatsapp disconnect` is the preferred removal path. It runs without a typed confirmation, sends WhatsApp a remote logout request when a paired local credential exists, then clears every account-bound SQLite table plus downloaded media, staged sends/snapshots, and audit data and requests deletion of the profile's master key from the OS credential store. Configuration and user-owned `outbox/` files are preserved. Baileys does not expose a server acknowledgement for the logout request, so verify **WhatsApp → Settings → Linked Devices** on the phone. Local cleanup still occurs when there is no paired credential or when a remote logout request fails after credential loading; in either case, remove the device manually if it remains listed because local credentials are no longer available for another attempt. If encrypted auth rows cannot be opened because the OS credential store is locked or unavailable, the command fails closed: unlock the store and retry, or purge locally and remove the linked device from the phone. `safewhatsapp unlink` remains an undocumented compatibility alias.

`safewhatsapp purge --yes` is local-only and does **not** log out the linked WhatsApp device. It removes the encrypted auth rows, requests deletion of their OS credential-vault key, and clears the local cache and configuration while preserving `outbox/`. Disconnect first when possible. If you already purged, remove the device from the phone's Linked Devices screen.

The application treats an explicit native deletion failure or a still-readable key as incomplete cleanup and retains `credential-vault.json` for retry. If repeated cleanup cannot be confirmed, `safewhatsapp purge --yes --abandon-key` explicitly removes that non-secret retry descriptor after the authentication ciphertext has been removed from the active state directory, allowing a new vault to be created. This may leave an orphaned wrapping key in the OS store.

The pinned binding suppresses some underlying OS read/delete errors, so a successful request plus an unreadable key is not cryptographic proof of key erasure. A leftover random wrapping key without the matching ciphertext cannot recover a WhatsApp session, but any retained copy of the schema-v8 database plus its descriptor remains decryptable while that OS key survives. Use `--abandon-key` only as recovery after `credential_cleanup_incomplete`, remove matching backups, snapshots, and hard-linked copies first, and remember that neither purge mode revokes the linked device on the phone.

Before a new QR pairing, an unpaired profile clears residual account data and retires any prior OS-vault key under the process lock, then creates fresh authentication state. Destructive cleanup requires the `.safe-whatsapp-mcp-state` ownership marker created by normal initialization, and refuses a directory without a valid marker. This guard reduces accidental deletion risk; it is not a substitute for using a dedicated state directory.

Schema v8 deliberately drops plaintext auth rows from unpublished schema-v7 development profiles, checkpoints and vacuums their SQLite pages, and requires re-pairing. This cannot erase copies already present in backups, snapshots, or synchronized folders. Remove those copies separately and revoke the old linked device from the phone if necessary.

## Trust boundaries

- WhatsApp messages and attachments are attacker-controlled input. They are data, never agent instructions.
- Only a structured, machine-resolved `senderE164` may be used for a cross-system identity lookup. Never derive an identity from a display name or message body.
- PN/LID alias links are accepted only from bounded structured transport metadata; privacy tombstones and clear cutoffs propagate across the linked aliases.
- This package does not contain Bliss access and cannot enforce authorization in another MCP. Combining it with a broad administration MCP increases prompt-injection impact.
- All cached direct and group chats are readable; there is no read allowlist in `0.2.3`.
- After browser review or legacy preparation and approval, sends may target any WhatsApp-verified direct `+E.164` number or existing group. There is no destination allowlist in `0.2.3`.
- Passing message or media plaintext to an AI model moves it outside WhatsApp's end-to-end-encrypted endpoint.

Use the least-privileged MCP set needed for a task. Prefer a narrow business-data tool that returns only the context authorized for the resolved person rather than a general database or administration tool.

## Send controls

The preferred outbound flow has two distinct authorities. The model-visible `open_whatsapp_send_review` tool may open and populate a local page but cannot send; Codex config may approve that opener without a prompt. Only the page's capability-authenticated button may call the internal reviewed-send operation. The edited payload is resolved again, persisted immutably, atomically claimed, and transported once.

The older preparation path remains for compatibility. It stores an immutable recipient and payload with a digest and short expiry; `send_prepared_whatsapp_message` requires the `pendingId`, digest, and unchanged approval preview. That legacy send tool remains destructive/open-world and must prompt on every call.

Both environment gates default off:

```text
SAFE_WHATSAPP_MCP_ENABLE_SEND=false
SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND=false
```

Enabling a flag does not constitute approval for an individual send. Only `open_whatsapp_send_review` is safe to auto-approve for WhatsApp transport because that MCP operation cannot send a message; opening its page may still perform the bounded first-link preview fetch described above. Never auto-approve `send_prepared_whatsapp_message`.
The supported Codex setup requires `--enable-send` before it accepts the additional `--enable-media-send` opt-in; media permission can never bypass the base send gate.

Direct-recipient verification requires WhatsApp to return exactly one phone JID encoding the requested canonical `+E.164` number. The approval preview visibly escapes invisible Unicode formatting controls, and the stored digest binds the exact recipient, payload, and preview. Before relay, the generated transport message ID is durably bound to the claimed send. Only an exact-ID server acknowledgement is treated as accepted; an explicit negative acknowledgement is failed, while timeout or disconnect is uncertain. Late negative acknowledgements are journaled before asynchronous reconciliation. A claimed send is never automatically retried; inspect the phone before preparing another draft after an uncertain result.

Media can be staged only from a real, regular file beneath `~/.safe-whatsapp-mcp/outbox/`. Path traversal, absolute paths, and symlink escapes are rejected. The outbox is user-controlled and is not removed by the general purge command.

Inbound media persists only a bounded WhatsApp `directPath` and media key, never a message-supplied host. Downloaded bytes are capped and signature-sniffed; only matching safe raster-image/audio formats can be embedded inline. Other media is an opaque resource. Authorization is rechecked after asynchronous download/cache operations and resource reads so deletion, expiry, and view-once state fail closed and remove cached bytes.

## Operational guidance

- Pair only from a trusted local terminal and the browser page it opens; a QR must never leave the machine.
- An npm installation requires supported Node.js. On macOS and Linux, `setup-codex` checks the stable package layout and pins the absolute Node executable and installed CLI paths; in-place upgrades take effect automatically, while path changes require setup again. Reinstall after a Node-major change so native modules match. Windows Codex registration is currently manual.
- A standalone bundle carries its own pinned Node runtime. Keep either runtime and the reviewed pinned dependencies current.
- Do not expose the STDIO process as a network service.
- Keep the broker bound to IPv4 loopback, preserve authenticated admission, and never place its capability in logs, stdout, arguments, or environment variables.
- Keep stdout exclusively for MCP protocol messages; send sanitized diagnostics to stderr.
- Inspect Linked Devices in WhatsApp regularly and remove anything unexpected.
- Use `safewhatsapp disconnect` before deleting or purging local state; local deletion alone cannot revoke a linked device.
- Close all Safe WhatsApp MCP clients before direct lifecycle commands or after changing broker-relevant configuration, policy, or version.
- Leave send flags disabled when using read-only workflows.
- Never let an agent, browser MCP, desktop-control tool, or accessibility automation operate the external send-review page.
- Never automatically retry a send whose network result is uncertain.
- Keep persistent Baileys message retry lookup disabled; reconnect-time retries must not relay messages that bypassed this package's staged-send confirmation.
- Do not enable persisted `cachedGroupMetadata` for sends; current participant metadata must be fetched before constructing a group message.
- Do not persist broad group metadata or participant rosters; only the bounded group title belongs in the local read model.
- Avoid live tests against a primary account until fake-socket, audit, package, and security tests pass.

## Logging and disclosure rules

Diagnostics and audit records must not contain message text, captions, QR content, full phone numbers or JIDs, contact/group names, filenames, attachment bytes, raw protocol messages, or auth material. Tests should enforce redaction.

If secrets or private content are exposed:

1. Stop the MCP server.
2. Remove the device from WhatsApp's Linked Devices screen.
3. Move the compromised state out of use and pair fresh credentials only after the cause is fixed.
4. Treat exposed conversation data according to the affected people's privacy requirements.

There is no promise that deleting local state recalls content already supplied to an external model or another system.
