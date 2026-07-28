# Changelog

All notable changes to this project will be documented here. The project follows [Semantic Versioning](https://semver.org/).

## 0.1.0 - Unreleased

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
- Atomic, idempotent `setup-codex` onboarding with a read-only default, explicit text-send opt-in, exact tool allowlist, and per-send human approval policy.
- Security documentation, cross-platform CI, and installed-package smoke checks.

### Fixed

- Pairing now waits for an ingested final recent-history chunk instead of mistaking pending offline notifications or the first history payload for synchronization completion.
- Codex onboarding canonicalizes macOS path aliases, recovers stale partial setup locks, reports preserved disabled entries accurately, and can move a generated registration from a recognized older standalone bundle to the current one.

### Changed

- `connect` now prints only essential QR and sync status, and `disconnect` runs directly with a concise result instead of repeating a warning and typed confirmation; `unlink` remains a compatibility alias.
- Pairing uses WhatsApp's compatible bounded-history mode; full-history registration is disabled because the retained cache is bounded and current handshakes may reject it before showing a QR.

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
