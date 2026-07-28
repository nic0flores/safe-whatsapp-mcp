# safe-whatsapp-mcp

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets an agent read a personal WhatsApp linked device, prepare an exact reply, and send only after a separate confirmation-gated tool call.

> [!WARNING]
> This project uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web protocol. It is not affiliated with or endorsed by WhatsApp or Meta, and use may violate [WhatsApp's terms](https://www.whatsapp.com/legal/terms-of-service) or cause an account restriction. Do not use it for spam, bulk messaging, or unattended automation.

This repository is at `0.1.0` and is **not published to npm yet**. Build and configure it from a reviewed local checkout.

## Quick start

With a reviewed standalone bundle installed, onboarding is three commands:

```bash
safewhatsapp setup-codex --enable-send
safewhatsapp connect
safewhatsapp status --live
```

Then restart Codex and ask it to list your recent WhatsApp chats. Omit `--enable-send` for read/draft-only access. The setup command uses Codex's own atomic configuration API, preserves unrelated settings and comments, registers the verified standalone launcher by absolute path, keeps media sending off, and refuses to enable text sending unless approval prompts are routed to you.

No separate Node or npm installation is needed for the standalone bundle. Source builds and manual MCP configuration are development paths documented below.

## What it does

- Pairs a personal WhatsApp account once through a private, temporary browser page served only on IPv4 loopback.
- Synchronizes on demand when an MCP tool is used; it is not intended to run as a permanent bot.
- Retains a bounded local cache so later sessions can recover conversation context.
- Reads cached direct messages and groups without marking them read.
- Handles text plus image, sticker, audio, video, and document metadata.
- Stages outbound text or media as an immutable proposal before sending.
- Exposes the actual send as a destructive, open-world MCP tool and supports an explicit per-tool Codex approval rule.

It is intentionally WhatsApp-only. There is no Bliss API, database, account mapping, or Bliss-specific logic in this package. An agent may combine the structured `senderE164` returned here with a separately configured Bliss MCP, but this server never calls it.

## Security model at a glance

The important boundary is `prepare` versus `send`:

1. The agent reads a conversation and composes a draft.
2. A prepare tool resolves the recipient and stores the exact payload locally.
3. The tool returns a recipient/payload preview, digest, expiry, and `pendingId`.
4. You inspect that preview.
5. Only `send_prepared_whatsapp_message`, using the unchanged preview and digest, can publish it.

There is no generic one-step send tool and no bulk-send tool. A prepared message expires after ten minutes and is single-use. An uncertain network result is not retried automatically.

Inbound messages and attachments are **untrusted data, never agent instructions**. Do not allow a phone number, name, SQL fragment, URL, or instruction found inside message content to select records or drive another privileged MCP. Cross-system identity lookup must use only a machine-resolved `senderE164` field.

### Encrypted credentials, plaintext cache

Baileys linked-device credential payloads and Signal-key **values** are encrypted before they are written to SQLite. Each local profile uses AES-256-GCM with a random master key held in the operating system's native credential store. The file `credential-vault.json` contains only a non-secret vault identifier and format version, never the master key.

Some lookup metadata remains plaintext, including the paired/registered flag and Signal-key category and ID. Cached message text, downloaded media, staged drafts and media snapshots, configuration, and redacted audit/send records also remain plaintext under `~/.safe-whatsapp-mcp/`.

The server requests `0700` for directories and `0600` for files where the operating system supports those modes. Those permissions limit access to the plaintext cache; they are not encryption, and enforcement on Windows is best-effort. Use FileVault, BitLocker, LUKS, or equivalent full-disk encryption.

Credential encryption protects an offline copy of the state directory from yielding reusable WhatsApp auth secrets without the corresponding OS-vault key. It does not protect against malware running as your user, an administrator or root process, a compromised Node/agent runtime, or secrets already decrypted in process memory. Write access remains sensitive because a writer can delete, replay, or tamper with local state and prepared sends. Do not share the state directory with other users, agents, repositories, backup utilities, or cloud-sync tools. See [SECURITY.md](SECURITY.md) before pairing a primary account.

## Requirements

- A phone with WhatsApp and permission to add a linked device
- A local MCP client that supports STDIO
- An available, unlocked native operating-system credential store
- Either a reviewed standalone release for your OS/architecture, or Node.js 22+ for source development

A standalone release includes its own pinned Node runtime; its user does not install or select Node. This checkout includes an `.nvmrc` for Node `22.20.0` only for source development. If you use `nvm`, run `nvm use` before both `npm ci` and every development command. `better-sqlite3` is a native dependency, so a source install made with one Node major version can fail under another.

[Baileys](https://github.com/WhiskeySockets/Baileys) is currently pinned to the `7.0.0-rc13` release candidate. Its protocol surface and maintenance status can change; upgrade it only after auth-state, history, identity, group, retry, and send tests pass.

## Install and build locally

```bash
cd /absolute/path/to/a/reviewed/safe-whatsapp-mcp
nvm use # when using nvm
npm ci
npm run build
npm link
```

`npm link` installs the local `safewhatsapp` command for the active Node installation. Do not use `npx safe-whatsapp-mcp` until an official package is published from this repository.

### Build a standalone release

On the build machine, run:

```bash
npm run build:standalone
npm run smoke:standalone
```

This creates `release/safewhatsapp-v<version>-<os>-<arch>/` plus a compressed archive on macOS and Linux. Keep the directory intact: its `safewhatsapp` launcher always invokes the private runtime beside it and never resolves `node` from `PATH`. The smoke check deliberately removes Node from `PATH`, then opens the local SQLite-backed status command through both the direct and symlinked launcher.

To install a reviewed archive without Node or npm, extract its whole directory to a stable location and link only its launcher onto `PATH`. For example, set `bundle_name` to the archive name for your version and target:

```bash
bundle_name=safewhatsapp-v0.1.0-darwin-arm64
mkdir -p "$HOME/.local/lib/safewhatsapp" "$HOME/.local/bin"
tar -xzf "$bundle_name.tar.gz" -C "$HOME/.local/lib/safewhatsapp"
ln -s "$HOME/.local/lib/safewhatsapp/$bundle_name/safewhatsapp" "$HOME/.local/bin/safewhatsapp"
```

Ensure `$HOME/.local/bin` is on the MCP client's `PATH`. Do not copy the launcher by itself; it needs the adjacent `runtime/` and `app/` directories. A signed installer can perform these steps for public releases.

Release bundles are platform- and architecture-specific because `better-sqlite3` and the operating-system credential-store adapter are native modules. Build each supported macOS/Linux target on that target with the same Node executable used to install its production dependencies. Windows standalone packaging is not implemented yet. A publicly downloaded macOS release must still be signed and notarized; the local builder does not claim to do that without the maintainer's Apple credentials.

## Pair the linked device

```bash
safewhatsapp connect
```

The command opens a crisp QR in your default browser. Scan it from **WhatsApp → Settings → Linked Devices → Link a device**. If the browser cannot be opened automatically, the terminal prints a short-lived local URL to open yourself.

The QR page binds only to `127.0.0.1` on an operating-system-selected port and uses a random 256-bit path token. The QR payload and PNG are not written to app state, temporary files, logs, audit data, MCP, or a remote service. They necessarily exist transiently in the Baileys/Node process, loopback HTTP response, and browser memory; owned PNG buffers are cleared on replacement/exit as a best effort. Responses are marked `no-store`. The document stays loaded while a token-protected same-origin poll updates only the QR image when WhatsApp rotates it. After the scan, the page removes the QR and shows the finishing state until the required credential save and WhatsApp socket restart succeed; it reports success only after the replacement socket opens. If the local process stops, the loaded page tells you to check the terminal instead of navigating to a browser error. Browser history may retain only the now-useless loopback URL.

When the command starts with an unpaired profile, it first clears any residual credentials, messages, downloaded media, pending sends, and audit data from a prior account. This happens under the state lock before fresh credentials are loaded; configuration and user-owned `outbox/` files are preserved. QR pairing persists the encrypted credentials before Baileys performs WhatsApp's mandatory post-scan reconnect, then waits up to two minutes for the final recent-history chunk to be ingested before disconnecting. Pending offline notifications and the first history chunk are not treated as completion. Full-history registration is deliberately disabled because the local cache is bounded and that mode is not accepted reliably by WhatsApp's current linked-device handshake. Later reads reconnect with the saved credentials. Normal shutdown never logs out or unpairs the device.

> [!IMPORTANT]
> Schema v8 intentionally discards plaintext authentication rows created by unpublished schema-v7 development builds, checkpoints and vacuums the database, and requires the linked device to be paired again. It does not attempt to encrypt those old secrets in place. The next `connect` also clears residual cache from the unpaired profile before showing a new QR.

Useful local commands:

```bash
safewhatsapp status
safewhatsapp status --live
safewhatsapp setup-codex
safewhatsapp setup-codex --enable-send
safewhatsapp serve
safewhatsapp disconnect
safewhatsapp purge --yes
safewhatsapp purge --yes --abandon-key # recovery only; see below
```

- `status` reads local state only; `status --live` performs a bounded connection check. Status reports credential encryption and plaintext cache storage separately as `credentialsAtRest` and `messageCacheAtRest`.
- `setup-codex` registers read/draft access in the user Codex configuration. `--enable-send` explicitly enables text sends while retaining the mandatory per-tool human approval; media sending remains disabled.
- `disconnect` immediately sends a remote logout request when a paired local credential exists, then clears all local account-bound state and requests deletion of that profile's OS credential-vault key while preserving configuration and `outbox/`. Baileys does not provide a server acknowledgement for that request. If the remote request fails after credentials are loaded, local cleanup still completes and the command reports the failure. `unlink` remains an undocumented compatibility alias.
- `purge --yes` is **local-only**. It removes the encrypted credentials, requests deletion of their OS credential-vault key, and clears cache, downloaded inbound media, pending sends, audit data, and configuration while preserving `outbox/`; it does not log out WhatsApp. Run `disconnect` first when possible, or remove the device in WhatsApp's Linked Devices screen.
- If key deletion cannot be confirmed, normal purge retains the non-secret vault descriptor so cleanup can be retried. After the encrypted auth rows have been removed from the active state directory, `purge --yes --abandon-key` is the explicit recovery path: it discards that descriptor and permits re-pairing even if an orphaned wrapping key may remain in the OS credential store.

OS credential-vault cleanup rejects an explicit deletion failure and also verifies that the key is no longer readable before removing the non-secret retry descriptor. The pinned native binding suppresses some OS read/delete errors, so this is a best-effort key deletion rather than cryptographic proof. Encrypted authentication rows are removed from the active state directory first; an orphaned random wrapping key alone cannot recreate WhatsApp credentials. However, while that OS key survives, a retained copy of the matching schema-v8 database and descriptor can still be decrypted. Use `--abandon-key` only after the normal command reports `credential_cleanup_incomplete`, only when you accept that an orphan may remain, and only after removing relevant backups, snapshots, and hard-linked copies.

Destructive cleanup requires the private `.safe-whatsapp-mcp-state` ownership marker created during normal initialization. Cleanup fails closed for an arbitrary absolute directory that was never initialized by this package. The marker itself and `outbox/` remain after purge so the dedicated profile can be safely reused.

### Optional local settings

Defaults can be lowered or raised within hard safety ceilings in `~/.safe-whatsapp-mcp/config.json`; start from [examples/config.example.json](examples/config.example.json). Every value must be positive, `maxMessagesPerChat` must be an integer, and `inlineMediaMiB` cannot exceed `maxMediaMiB`.

| Setting | Default | Maximum |
| --- | ---: | ---: |
| `retentionDays` | 7 | 3,650 |
| `maxMessagesPerChat` | 200 | 10,000 |
| `pendingTtlMinutes` | 10 | 1,440 |
| `connectionTimeoutSeconds` | 15 | 600 |
| `syncTimeoutSeconds` | 15 | 120 |
| `idleTimeoutSeconds` | 60 | 3,600 |
| `inlineMediaMiB` | 8 | 8 |
| `maxMediaMiB` | 25 | 25 |

`connectionTimeoutSeconds` applies to ordinary linked-device reconnects. Interactive QR pairing uses a separate five-minute connection window and a two-minute recent-history window.

Tests or isolated local profiles may set `SAFE_WHATSAPP_MCP_STATE_DIR` to an absolute state-directory path. Do not point it at a repository, shared folder, cloud-synchronized directory, or a directory containing unrelated files.

## Configure Codex

Use the reviewed standalone installation to configure Codex automatically:

```bash
safewhatsapp setup-codex                 # read and draft; sending off
safewhatsapp setup-codex --enable-send   # confirmation-gated text sending
```

This updates only `mcp_servers.safe_whatsapp` through Codex's atomic configuration API. It does not change the user's global model, sandbox, approval policy, or approval reviewer. A same-name server with a different command is treated as a conflict instead of being overwritten. Existing stricter server approval settings, disabled state, and tool deny list are preserved. Run the command again after installing a newer standalone bundle so Codex follows the new verified launcher.

If an existing Safe WhatsApp entry is disabled, setup leaves it disabled and says so. Enable that entry in Codex before restarting if you want its tools loaded.

`--enable-send` fails if effective Codex settings use `approval_policy = "never"` or route approvals to an automated reviewer. Project, profile, session, or managed configuration can still override the user configuration; review those layers if Codex reports the server as overridden.

Restart Codex after setup. The ChatGPT desktop app, Codex CLI, and IDE extension on the same host share the MCP configuration.

For manual review or another machine, [examples/codex-config.toml](examples/codex-config.toml) shows the generated server policy. Replace its launcher placeholder with the absolute path to a reviewed standalone `safewhatsapp`; never configure Codex against `node`, `npx`, a checkout's `dist/cli.js`, or a launcher copied without its adjacent bundle.

The example follows the current [official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp.md), including server-level and per-tool approval modes.

The important approval settings are:

```toml
approval_policy = "on-request"
approvals_reviewer = "user"

[mcp_servers.safe_whatsapp]
command = "/absolute/path/to/reviewed/standalone/safewhatsapp"
args = ["serve"]
default_tools_approval_mode = "writes"

[mcp_servers.safe_whatsapp.env]
SAFE_WHATSAPP_MCP_ENABLE_SEND = "false"
SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND = "false"

[mcp_servers.safe_whatsapp.tools.send_prepared_whatsapp_message]
approval_mode = "prompt"
```

`approval_policy = "on-request"` allows interactive MCP prompts, and `approvals_reviewer = "user"` prevents them from being delegated to an automatic reviewer. `default_tools_approval_mode = "writes"` prompts for tools that are not marked read-only, while the explicit per-tool rule forces a human prompt for the external send. The server also marks that tool destructive and open-world. Set the text-send environment gate to `true` only after these settings are effective. Do not weaken them for routine use.

For another STDIO client, start from [examples/stdio-client.example.json](examples/stdio-client.example.json) and configure that client's equivalent of “always prompt before this tool.” If the client cannot enforce per-tool approval, leave sending disabled.

## Sending controls

Sending is off unless explicitly enabled in the MCP server environment:

| Variable | Default | Effect |
| --- | --- | --- |
| `SAFE_WHATSAPP_MCP_ENABLE_SEND` | `false` | Allows prepared text sends and is also required for media sends. |
| `SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND` | `false` | Additionally allows prepared media sends. |

These flags are a deployment gate, not user confirmation. Every message still follows prepare → inspect → approved send.

Direct destinations must be canonical `+E.164` numbers and are verified with WhatsApp. Groups must already exist and are addressed through their opaque chat IDs. There is deliberately no send allowlist in `0.1.0`: after staging and approval, a send can target any verified direct number or existing group. Broadcasts, channels, status, and arbitrary raw JIDs are rejected.

The approval preview visibly escapes bidirectional and other invisible Unicode formatting controls. This makes recipient names and message text inspectable without changing the bytes that will actually be sent; the digest binds both the exact payload and that displayed preview.

For outbound media, first place the file in:

```text
~/.safe-whatsapp-mcp/outbox/
```

The media prepare tool accepts only a relative path beneath that directory. Absolute paths, traversal, symlink escapes, non-regular files, and files over the configured limit (hard maximum 25 MiB) are rejected. Preparation snapshots the exact bytes into private pending storage and binds their hash and metadata into the digest. The server cannot send an arbitrary workspace or home-directory file. Images, video, audio, and documents are supported; audio captions are rejected because WhatsApp's audio payload does not carry them.

## MCP tools

| Tool | Purpose | Remote side effect |
| --- | --- | --- |
| `get_whatsapp_status` | Pairing, cache, sync, retention, and feature status | No |
| `list_whatsapp_chats` | Paginated direct/group summaries | No |
| `read_whatsapp_chat` | Paginated retained messages without marking read | No |
| `fetch_older_whatsapp_messages` | Request one best-effort batch of older messages for a cached chat | No chat mutation; writes retained local cache |
| `search_whatsapp_messages` | Search retained text and captions | No |
| `get_whatsapp_media` | Explicitly decrypt one retained attachment | No |
| `list_whatsapp_sends` | Inspect staged and historical send records | No |
| `prepare_whatsapp_text_send` | Stage an exact text payload | No; writes local state |
| `prepare_whatsapp_media_send` | Snapshot and stage outbox media | No; writes local state |
| `send_prepared_whatsapp_message` | Send one immutable staged payload | **Yes; always approve** |
| `discard_prepared_whatsapp_message` | Remove one unsent staged payload | No; writes local state |

All cached direct and group conversations are readable. `0.1.0` has no read allowlist. Keep this in mind before giving an agent other privileged tools in the same conversation.

`fetch_older_whatsapp_messages` makes one bounded request for at most 50 messages. It never follows the history automatically; each additional batch requires another explicit tool call. Current Baileys companion-device behavior is best effort: WhatsApp may accept a request without delivering the history response before the bounded wait ends. In that case the tool reports `pending` rather than claiming that the chat has no older history.

When a batch arrives, `newlyRetainedCount` and `anchorAdvanced` distinguish real paging progress from a duplicate response. An optional `beforeMessageId` is accepted only when it still identifies the current oldest retained message, preventing a stale cursor from replacing older cache entries near the per-chat limit.

Fetched messages pass through the same deletion, expiry, view-once, and deduplication rules as synchronized messages. They also obey the configured `retentionDays` and `maxMessagesPerChat` limits, so a batch outside those bounds may not remain in the local cache. Raise those settings deliberately before retaining more history; the expanded cache remains plaintext under private file permissions.

## Data behavior

- Default retention is seven days and at most 200 messages per chat.
- Synchronization may report `partial`; a linked device cannot make a stateless, complete inbox fetch on every launch.
- Older-history fetching is one best-effort batch of at most 50 messages per explicit call; it does not page automatically, and `pending` does not mean the end of history.
- Incoming history and live updates are deduplicated. Edits, revocations, deletions, and disappearing-message expiry are applied before data is exposed.
- Direct-chat edits, revocations, clear events, and tombstones propagate across WhatsApp's verified PN/LID aliases, including when that alias mapping arrives after the deletion.
- View-once media is never persisted or exposed.
- Attachment bytes are downloaded only after `get_whatsapp_media` is called, up to 25 MiB.
- Retained media stores only a bounded WhatsApp `directPath` and media key. Message-supplied download URLs are discarded; the production downloader constructs the request against Baileys' fixed WhatsApp media host.
- Downloaded bytes are signature-sniffed. Only matching, recognized raster-image or audio bytes up to 8 MiB may be returned inline; SVG, mismatched content, video, documents, and larger content are exposed as opaque MCP resources.
- A media message is reauthorized after download/cache awaits and again when an opaque resource is read, so a concurrent revocation or expiry invalidates its cache instead of returning stale bytes.
- Downloaded attachment bytes are reconciled to retained message IDs, so expiry, deletion, and the seven-day/200-message limits also remove their cache.
- A new pairing cannot inherit an old account's cache or staged sends: an unpaired profile is cleared before fresh in-memory auth state is created.
- The socket closes after 60 seconds of inactivity and reconnects on demand.
- The server does not send presence, typing, or read receipts, and does not archive, mute, or otherwise mutate chats.
- Persistent database-backed WhatsApp message retry lookup is disabled, preventing reconnect-time relay of unrelated `fromMe` messages outside this package's staged-send path.
- Group sends do not reuse persisted participant metadata; Baileys fetches current group metadata before constructing a send.
- Group roster metadata is not retained at all; group events keep only the bounded chat title needed by the read/approval UI.
- Redacted send/audit metadata is retained for 30 days. Logs must not include message text, QR data, full phone/JID values, contact/group names, filenames, or auth material.

WhatsApp content is end-to-end encrypted in transit to the linked-device endpoint. When an MCP client sends that plaintext to a configured AI model, it has left the WhatsApp encryption boundary. Minimize the messages and media you provide to any model and understand that model provider's data controls.

## Scope exclusions

`0.1.0` does not support group administration, broadcasts, channels, status, reactions, outbound edit/delete, calls, location, contacts, polls, view-once sending, auto-replies, scheduled sends, or bulk sends.

## Development

```bash
npm run typecheck
npm test
npm run audit:prod
npm run pack:dry-run
npm run smoke:pack
```

Tests use injected fake sockets; they must not connect to WhatsApp. A live personal-account acceptance test is manual, opt-in, and runs only after automated security and packaging checks pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and license

The package has not been published to npm or released publicly. Recheck the package name immediately before a separate, explicitly approved publish operation.

Licensed under the [MIT License](LICENSE).
