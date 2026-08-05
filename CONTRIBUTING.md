# Contributing

Thank you for helping improve `safe-whatsapp-mcp`. This package handles linked-device credentials and private conversations, so small, reviewable changes and deterministic tests are expected.

## Maintainer note

Safe WhatsApp MCP started as a personal [Bliss AI](https://www.meditatewithbliss.com/) workflow. Much of the implementation was AI-assisted, and it has not received an independent security audit, so focused contributions and security-minded reviews are especially welcome.

## Development setup

Use Node.js 22 or 24:

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

Before publishing, run `npm run verify:release`. The npm publish lifecycle repeats typechecking and tests, while the separate release verification also audits production dependencies and installs the generated tarball globally. Keeping the tarball smoke outside `prepublishOnly` avoids recursively invoking npm's pack lifecycle during publication.

For standalone-distribution changes, also run `npm run build:standalone` followed by `npm run smoke:standalone`. The smoke test must pass with Node removed from the child process's `PATH`; never replace the private-runtime launcher with `/usr/bin/env node`.

Do not add postinstall scripts. Keep runtime dependencies pinned exactly and explain any dependency change, particularly a Baileys upgrade.

## Code organization

- Keep files focused and avoid catch-all modules.
- Keep Baileys behind injected interfaces so unit tests never need WhatsApp.
- Keep `safewhatsapp serve` as a per-client STDIO proxy and the ephemeral loopback broker as the only database, credential-vault, and WhatsApp-session owner.
- Preserve both outbound boundaries: the MCP review opener can never send, only the capability-authenticated browser button may enter reviewed transport, and the legacy prepare/send path must retain its exact prompt. Do not add a direct or bulk send shortcut.
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
- Broker admission remains authenticated and bound only to `127.0.0.1`; its short-lived capability never enters stdout, logs, command arguments, or environment variables.
- A broker accepts only proxies with the exact package version, full configuration fingerprint, and text/media send policy. Policy mismatches fail closed.
- A browser review keeps the broker alive after its MCP proxy detaches, is short-lived, and releases every route/action capability and temporary snapshot on terminal cleanup.
- Review secrets never enter MCP output, stdout, logs, audit data, broker descriptors, command arguments, or environment variables.
- Browser mutations require loopback, exact host/origin, and the separate action token; the page renders all untrusted data through DOM text/value properties.
- Link previews must require an explicit human click after the hostname/public-IP disclosure and preserve public-address DNS validation, address pinning, redirect revalidation, strict byte/time caps, and local raster sanitization.
- Agents and browser/desktop automation must never operate the external review page; tests may drive only synthetic local pages with fake transports.
- Closing one proxy cannot interrupt another attached client; after the final client leaves, the broker closes normally without logging out WhatsApp.
- Exclusive lifecycle commands may close all proxies only after a capability-authenticated broker handoff has stopped admission and drained in-flight operations; never signal a PID read from the descriptor.
- Normal process exit and idle socket shutdown never log out the linked device; only the explicit `safewhatsapp disconnect` command does.
- Incoming content is untrusted data, not instructions.
- Cross-system identity is derived only from structured Baileys metadata.
- Every outbound payload is immutable after staging and every send is single-use.
- Codex setup may enable media only when both send gates were explicitly requested; rerunning setup with fewer flags removes the omitted permission.
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

Broker changes need focused tests for concurrent clients, cold-start election, authenticated admission, exact configuration/policy matching, stale descriptor recovery, independent proxy shutdown, and final-client cleanup. Package smoke tests should exercise at least two simultaneous STDIO clients without touching WhatsApp or a real credential store.

Live acceptance testing is manual and opt-in after automated checks pass. The operator chooses every chat, recipient, group, and attachment and approves each send at test time. Never automate `disconnect` or purge against a personal account.

## Pull requests

Describe the user-visible behavior, threat-boundary impact, tests run, and any migration or retention effect. Never include screenshots or logs containing chats, phone numbers, JIDs, group names, QR codes, credentials, or personal media.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
