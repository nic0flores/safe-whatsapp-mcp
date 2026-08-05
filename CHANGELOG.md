# Changelog

All notable changes to this project will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## 0.2.2 - 2026-08-05

### Added

- Exact-ID WhatsApp server acknowledgement tracking with distinct accepted, rejected, and uncertain outcomes.
- `resync_whatsapp_messages` for an app-state deletion/clear refresh with explicit non-authoritative reconciliation reporting.

### Fixed

- The review receipt no longer treats a locally generated Baileys message ID or WebSocket write as WhatsApp acceptance.
- Generated transport IDs are durably bound before relay; late exact-ID negative acknowledgements are journaled, race-safe, and reconcile retained send records and open review receipts to failed.
- Baileys local outbound echoes and outbound retry caches are disabled without weakening inbound decryption recovery. Cached chat history now changes only through WhatsApp history/events.
- Timeouts cover both the relay and acknowledgement wait, and known WhatsApp outcomes are not relabelled by a later local ledger-write failure.

## 0.2.1 - 2026-07-29

### Changed

- Pairing, finalizing, linked, and failure screens now use the same Bliss visual system and three-petal mark as the browser send review.
- The finalizing screen now shows an accessible activity indicator while WhatsApp completes linking, including a motion-reduced state.

### Fixed

- Link-preview loading is now visible, a temporary preview failure offers a single user-controlled retry instead of silently hiding the card, and slow optional artwork no longer discards already validated title and description metadata.

## 0.2.0 - 2026-07-29

### Added

- `open_whatsapp_send_review`, a non-sending MCP tool that opens a private editable browser composer for direct numbers or cached groups.
- Supported global npm onboarding through the canonical `safewhatsapp` CLI on macOS and Linux, with `setup-codex` pinning absolute Node and installed CLI paths and safely repairing its own stale path entry.
- Browser-side recipient, text/caption, reply-context, and attachment editing plus automatic link-card inspection/removal with a Bliss-inspired responsive interface.
- A compact three-state review surface: editable draft, accessible sending loader, and an exact post-send receipt that retains only safe display metadata after attachment cleanup.
- A dependency-free emoji focus helper that exposes the native `Fn-E` shortcut on macOS instead of bundling a partial emoji set.
- Link previews load automatically for link-only drafts and can be removed without changing the message; drafts with attachments make no preview request.
- Bounded file-picker replacement uploads and safe same-origin previews for images, audio, video, and document metadata.
- Automatic link cards with public-address DNS validation, pinned requests, redirect/time/byte limits, HTML metadata parsing, and sanitized local JPEG thumbnails.
- Broker-owned review leases so a page remains usable after its initiating Codex proxy disconnects.

### Changed

- Codex setup auto-approves only the non-destructive review opener; the retained `send_prepared_whatsapp_message` compatibility tool still prompts every time.
- Codex setup accepts either a verified npm installation or reviewed standalone bundle; npm users rerun setup after package or Node-path upgrades.
- Reviewed sends freeze the browser-edited revision into the existing immutable, serialized, single-use transport path and explicitly pass the reviewed link card or disable Baileys preview fetching.
- Package and broker protocol compatibility version is now `0.2.0` so older brokers cannot expose a mismatched tool surface.

### Security

- Each review uses separate 256-bit route and action capabilities; the action secret is delivered in the URL fragment and never appears in MCP output, logs, audit data, or the broker descriptor.
- Loopback review mutations require exact host, origin, action token, method, content type, and bounded bodies, with no CORS and restrictive no-store browser headers.
- Group labels visibly disambiguate cached destinations, bidirectional controls are exposed, attachment revisions reject stale tabs, and all state-changing review operations are serialized.
- At most one browser click can enter transport; expiry, cancellation, browser-launch failure, broker shutdown, and terminal cleanup remove unsent media and capabilities.
- Submitted receipts omit action/route secrets, revision and transport IDs, JIDs, media paths, hashes, and bytes; terminal state rotates the server action capability and the page clears its stored copy.
- Link previews reject credentials, nonstandard ports, mixed/private/reserved DNS results, unsafe redirects, oversized responses, and unsanitized remote artwork.

## 0.1.0 - 2026-07-28

### Added

- Initial local STDIO MCP server package for a personal WhatsApp linked device.
- On-demand synchronization with bounded local message retention.
- Structured direct/group reads and explicit inbound media retrieval.
- Explicit best-effort retrieval of one bounded older-message batch without automatic pagination.
- Immutable text and media staging with a separate confirmation-gated send.
- Local CLI for pairing, safe Codex registration, status, serving, disconnecting, and purging state.
- Polished pairing and status display in a temporary, tokenized, no-store browser page bound only to IPv4 loopback, with no remote assets.
- Stable in-page QR rotation and an explicit post-scan finishing state while credentials persist and Baileys completes WhatsApp's required socket restart.
- Canonical `safewhatsapp` CLI naming and platform-specific release bundles with a private Node runtime.
- Atomic, idempotent `setup-codex` onboarding with a read-only default, separate text/media send opt-ins, an exact tool allowlist, and per-send human approval policy.
- An ephemeral authenticated IPv4-loopback broker lets multiple Codex agents safely share one database owner and on-demand WhatsApp session while retaining per-client STDIO MCP processes.
- Security documentation, cross-platform CI, and installed-package smoke checks.

### Fixed

- Pairing now waits for an ingested final recent-history chunk instead of mistaking pending offline notifications or the first history payload for synchronization completion.
- Codex onboarding canonicalizes macOS path aliases, recovers stale partial setup locks, reports preserved disabled entries accurately, and can move a generated registration from a recognized older standalone bundle to the current one.
- Concurrent agents now serialize outbound transports and inbound-media cache transitions, so distinct sends never overlap and reconciliation cannot observe a partial cache pair.
- Process-lock metadata reads are bounded and no-follow, and broker shutdown/authentication are hardened against descriptor-generation and socket-reset races.
- Exclusive lifecycle commands now coordinate an authenticated broker handoff instead of failing with `state_locked` while Codex agents are attached.
- CLI status now inspects an existing broker without competing for SQLite or inheriting the terminal's send-policy mismatch, while stale broker generations and launch races recover safely.
- Baileys is updated to `7.0.0-rc14` so new connections use WhatsApp's current Web client revision instead of being rejected with status `405`.

### Changed

- `connect` now prints only essential QR and sync status, and `disconnect` runs directly with a concise result instead of repeating a warning and typed confirmation; `unlink` remains a compatibility alias.
- Pairing uses WhatsApp's compatible bounded-history mode; full-history registration is disabled because the retained cache is bounded and current handshakes may reject it before showing a QR.
- `safewhatsapp serve` is now a small STDIO proxy; the shared broker starts when needed, remains only while clients are attached, and exits without logging out the linked device.

### Security

- Outbound sending defaults off and requires both deployment flags and a staged payload.
- Baileys credential payloads and Signal-key values are encrypted with AES-256-GCM using a random master key held in the native OS credential store; message, media, draft, and audit caches remain plaintext with private permissions.
- Disconnect and fresh pairing isolate accounts by clearing all account-bound tables/files while preserving configuration and the user outbox.
- Local purge is explicitly non-revoking and destructive cleanup requires a package ownership marker.
- Recipient resolution is bound to the requested E.164 number, and approval previews visibly escape invisible Unicode controls.
- Retained media discards message-supplied hosts, signature-checks inline bytes, and reauthorizes after asynchronous download/cache boundaries.
- Schema v5 scrubs legacy raw envelopes, v6 removes legacy group rosters, v7 marks old source timestamps untrusted for alias-clear reconciliation, and v8 discards unpublished plaintext auth rows, scrubs their SQLite pages, and requires re-pairing.
- Persistent database-backed message retry relay is disabled, and uncertain sends are never automatically retried.
- Group sends fetch live metadata instead of trusting persisted participant lists.
- Chat deletion is monotonic against queued/history replay, and account cleanup removes stale SQLite rollback journals.
- Direct-message deletion, clear, and edit state is reconciled across verified PN/LID aliases, including late mappings.
- Codex registration upgrades accept only an older private bundle with the exact recognized launcher and matching bounded package/bundle metadata; arbitrary same-name MCP commands remain conflicts.
- Broker clients authenticate with a short-lived local capability and must match the broker's exact version, configuration, and send policy before receiving an MCP connection.
