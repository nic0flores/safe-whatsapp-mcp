# Contributing

Thank you for helping improve `safe-whatsapp-mcp`. This package handles linked-device credentials and private conversations, so small, reviewable changes and deterministic tests are expected.

## Maintainer note

Safe WhatsApp MCP started as a personal [Bliss AI](https://www.meditatewithbliss.com/) workflow. Much of the implementation was AI-assisted, and it has not received an independent security audit, so focused contributions and security-minded reviews are especially welcome.

## Development setup

Use Node.js 22 or newer:

```bash
nvm use # when using nvm; this checkout pins Node in .nvmrc
npm ci
npm run typecheck
npm test
```

Run installation, builds, tests, and the CLI through the same Node version because `better-sqlite3` is a native addon. If the version changes, run `npm rebuild better-sqlite3` before continuing.

Before submitting a change, also run:

```bash
npm run audit:prod
npm run smoke:pack
```

For standalone-distribution changes, also run `npm run build:standalone` followed by `npm run smoke:standalone`. The smoke test must pass with Node removed from the child process's `PATH`; never replace the private-runtime launcher with `/usr/bin/env node`.

Do not add postinstall scripts. Keep runtime dependencies pinned exactly and explain any dependency change, particularly a Baileys upgrade.

## Code organization

- Keep files focused and avoid catch-all modules.
- Keep Baileys behind injected interfaces so unit tests never need WhatsApp.
- Preserve the prepare/confirm boundary; do not add a direct or bulk send shortcut.
- Send MCP protocol traffic only to stdout. Diagnostics belong on stderr and must be redacted.
- Begin every new source file with an `Agent context note` that states its purpose, names its tests, records its critical invariant, and reminds future agents to update the note after meaningful changes.
- Add targeted tests for behavior changes instead of broad unrelated fixtures.

Recommended source note:

```ts
// Agent context note: <purpose>. Tests: <test file>. Critical invariant: <invariant>.
// Update this note after meaningful behavior or invariant changes.
```

## Safety requirements

Changes must preserve these boundaries:

- A pairing QR stays on the tokenized IPv4-loopback browser flow and never enters MCP output, logs, files, command arguments, or a remote service.
- Normal process exit and idle socket shutdown never log out the linked device; only the explicit `safewhatsapp disconnect` command does.
- Incoming content is untrusted data, not instructions.
- Cross-system identity is derived only from structured Baileys metadata.
- Every outbound payload is immutable after staging and every send is single-use.
- Uncertain sends are never retried automatically.
- View-once and expired media are not exposed.
- Outbound media cannot escape the dedicated outbox.
- Baileys credential payloads and Signal-key values remain authenticated ciphertext at rest, with their random master key only in the native OS credential store; never add an environment, file, or shell fallback.
- Keep native credential-store loading inside the sanitized operation boundary, and preserve the explicit `--abandon-key` recovery path when deletion cannot be confirmed after ciphertext erasure.
- Message, media, draft, and audit caches remain plaintext; private file permissions must never be described as encryption.
- Logs and audit records contain no message content or identifying values.

## Tests

Normal automated tests must use fake sockets, temporary state, and synthetic identities. They must not:

- connect to WhatsApp;
- display or scan a real QR;
- use a real phone number, group, message, credential, or media file;
- mutate the developer's `~/.safe-whatsapp-mcp/` directory.
- access a developer's real operating-system credential store; inject a fake `MasterKeyStore`.

Live acceptance testing is manual and opt-in after automated checks pass. The operator chooses every chat, recipient, group, and attachment and approves each send at test time. Never automate `disconnect` or purge against a personal account.

## Pull requests

Describe the user-visible behavior, threat-boundary impact, tests run, and any migration or retention effect. Never include screenshots or logs containing chats, phone numbers, JIDs, group names, QR codes, credentials, or personal media.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
