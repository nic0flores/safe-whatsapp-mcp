# Safe WhatsApp MCP

[![CI](https://github.com/dhruvratra/safe-whatsapp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/dhruvratra/safe-whatsapp-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22 or 24](https://img.shields.io/badge/Node.js-22%20%7C%2024-339933?logo=node.js&logoColor=white)](package.json)
[![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#project-status)

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets an agent read a personal WhatsApp linked device, draft a reply, and open an editable private review page where you decide whether to send it.

It uses your personal WhatsApp linked-device session. It does not use Meta's WhatsApp Business Platform or Cloud API, and it does not require a business account.

> [!WARNING]
> This project uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web protocol. It is not affiliated with or endorsed by WhatsApp or Meta, and use may violate [WhatsApp's terms](https://www.whatsapp.com/legal/terms-of-service) or cause an account restriction. Do not use it for spam, bulk messaging, scraping, or unattended automation.

## Project note

Safe WhatsApp MCP was initially built for a personal [Bliss AI](https://www.meditatewithbliss.com/) workflow. Much of the implementation was AI-assisted, and it has not received an independent security audit. It was designed around a narrow, human-reviewed workflow, but you should still review it before pairing a primary account or exposing sensitive conversations to an AI model.

Issues, security-minded reviews, and small auditable improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Project status

Version `0.2.1` is the current public release with supported npm onboarding. The project remains experimental and there are no signed GitHub standalone downloads yet; review the source and security model before pairing a primary account.

## Quick start

The supported npm setup on macOS and Linux has four short steps: install, connect WhatsApp, add the MCP to Codex, and restart Codex. Before starting, make sure Node.js 22 or 24 and the `codex` command are available on `PATH`.

### 1. Install Safe WhatsApp

```bash
npm install --global safe-whatsapp-mcp
safewhatsapp --version
```

npm installs every runtime dependency and adds the `safewhatsapp` command; the second command prints the installed version. You do not need to clone this repository, run a build, or invoke `node dist/cli.js`. Installation itself does not pair WhatsApp or change Codex configuration.

If the shell reports `safewhatsapp: command not found`, add the global npm executable directory to `PATH` and retry. On macOS and Linux that directory is normally the `bin/` directory under the path printed by `npm prefix --global`; do not work around it with `node dist/cli.js`, npm link, or ephemeral `npx`.

### 2. Connect your personal WhatsApp

```bash
safewhatsapp connect
```

This opens a private QR page in your default browser. On iPhone, open **WhatsApp → Settings → Linked Devices → Link a Device**. On Android, open **WhatsApp → ⋮ → Linked devices → Link a device**. Scan the QR, then keep WhatsApp open on the phone and leave the terminal command running while linking finishes. The page changes to **WhatsApp linked** and the command exits after the connection is ready. If the browser cannot be opened automatically, the terminal prints the private local URL instead.

On macOS, the first connection may ask you to allow Keychain access. Safe WhatsApp keeps the random key used to encrypt linked-device credentials in the native credential store; denying access prevents the credentials from being saved securely.

A normal first connection ends with:

```text
Scan the QR code opened in your browser.
QR scanned. Connecting…
WhatsApp connected.
```

The initial recent-message sync can take up to two minutes. `WhatsApp connected; message sync is incomplete.` is also a successful pairing: the encrypted link was saved, and later tool calls reconnect on demand. Check `safewhatsapp status --live` and retry the read before unlinking. If the account is already paired, `connect` checks the link and synchronizes without showing another QR.

### 3. Add it to Codex

For browser-reviewed text and media sending, run:

```bash
safewhatsapp setup-codex --enable-send --enable-media-send
```

Choose the smallest access level you need:

| Access | Command |
| --- | --- |
| Read and draft only | `safewhatsapp setup-codex` |
| Read, draft, and reviewed text sending | `safewhatsapp setup-codex --enable-send` |
| Read, draft, and reviewed text/media sending | `safewhatsapp setup-codex --enable-send --enable-media-send` |

The command updates only the `safe_whatsapp` entry in your user Codex configuration. It does not change your model, global sandbox, or approval settings. A fresh enabled setup ends with `Restart Codex to load the WhatsApp tools.` If an existing Safe WhatsApp entry is disabled, setup preserves that choice and tells you to enable it before restarting.

### 4. Restart Codex and try it

Completely restart the Codex app, CLI session, or IDE extension you use. You can check the WhatsApp link from the terminal:

```bash
safewhatsapp status --live
```

A successful live check includes both `"paired": true` and `"connected": true`. This verifies the WhatsApp link; the next prompt separately verifies that Codex loaded the MCP:

- “List my recent WhatsApp chats.”
- “Read the recent messages in the chat listed as `<exact chat title>` and summarize what needs a reply.”
- “Draft a short reply in that chat, but do not send it.”
- “Open that draft in the WhatsApp review page.”

Use a chat returned by the list for follow-up requests. WhatsApp does not always provide a saved address-book name, so Codex may need the returned chat title, phone number, or opaque chat ID rather than a name you know only from your phone.

After setup, normal use happens inside Codex; there is no command you need to keep running. Safe WhatsApp connects on demand when a tool needs WhatsApp and closes its shared connection after inactivity.

When you ask Codex to open a send review, it opens a private local composer without an MCP approval prompt. You can edit the recipient, message, group, reply context, and attachment, then inspect or remove the generated link card. Nothing is sent until you click **Send on WhatsApp**. While WhatsApp is contacted, the editor shows a sending indicator; afterward it shows a frozen summary of what was sent or what failed. On macOS, **Emoji · Fn-E** focuses the message field so `Fn-E` or `Control-Command-Space` can open the complete system Character Viewer.

### Installation details and upgrades

For an npm installation, `setup-codex` verifies a stable installed-package layout and pins the absolute paths of both the current Node executable and installed CLI instead of relying on `PATH` when MCP starts. An in-place npm upgrade takes effect at those paths automatically. Run `setup-codex` again if the Node or global npm prefix path changes; its setup marker lets a new installation repair its own stale entry without replacing an unrelated same-name server. Reinstall the package after changing Node major versions so native dependencies match, then restart Codex. The command uses Codex's atomic configuration API, preserves unrelated settings and comments, keeps all sending opt-in, and refuses to enable sending unless approval prompts are routed to you.

Automatic `setup-codex` is currently supported on macOS and Linux. The installed MCP server itself is package-smoke-tested on Windows, but Windows users must configure the STDIO entry and approval policy manually for now.

If you do not want Node installed on the destination machine, use the [standalone bundle](#alternative-build-a-standalone-bundle), which carries its own pinned Node runtime. Source development remains documented below as a separate path.

## What it does

- Pairs a personal WhatsApp account once through a private, temporary browser page served only on IPv4 loopback.
- Synchronizes on demand when an MCP tool is used; it is not intended to run as a permanent bot.
- Lets multiple local Codex agents share one short-lived broker instead of competing for the SQLite database and WhatsApp session.
- Retains a bounded local cache so later sessions can recover conversation context.
- Reads cached direct messages and groups without marking them read.
- Handles text plus image, sticker, audio, video, and document metadata.
- Opens a compact, short-lived browser composer for an editable text or media draft.
- Focuses the editor for the operating system's emoji input and shows the native `Fn-E` shortcut on macOS without bundling an emoji dataset.
- Makes the browser button—not the non-destructive MCP opener—the authorization point for the new send flow.
- Retains the older immutable prepare/confirm tools for compatibility, with the actual legacy send still marked destructive and configured to prompt.

It is intentionally WhatsApp-only. There is no Bliss API, database, account mapping, or Bliss-specific logic in this package. An agent may combine the structured `senderE164` returned here with a separately configured Bliss MCP, but this server never calls it.

### Multiple agents, one local broker

Each `safewhatsapp serve` process remains a normal STDIO MCP server from its Codex client's point of view, but it is only a small proxy. The first proxy starts one ephemeral broker bound to `127.0.0.1` on an operating-system-selected port. That broker alone owns the state lock, SQLite connection, and WhatsApp session; every attached proxy receives its own MCP connection to the shared services.

The loopback connection is authenticated with a short-lived local capability recorded in private `broker.json`. This file is requested as mode `0600` where supported and contains broker coordination data, not WhatsApp credentials or the credential-vault master key. A proxy must match the broker's exact package version, configuration, and text/media send policy before it is admitted. If you change settings, send gates, or the installed bundle while another client is open, close and restart all Codex clients using Safe WhatsApp.

The broker exists only while MCP clients or browser reviews are active and exits after the last one leaves or closes. Its shared WhatsApp socket still connects only when a tool needs it, closes after the configured inactivity timeout (60 seconds by default), and reconnects on demand. Pairing remains an explicit `safewhatsapp connect` operation; the broker cannot surface a QR through MCP. If `connect`, `disconnect`, or `purge` needs exclusive profile access while agents or reviews are active, the command authenticates an internal handoff request, cancels unsent reviews, lets in-flight work drain, and then takes the state lock. That maintenance handoff closes attached Safe WhatsApp MCP connections without logging out; clients can reconnect after the command finishes.

`safewhatsapp status` is non-disruptive: it attaches to an existing broker for the status read regardless of that broker's send-policy setting. When no broker exists, it reads the profile directly under the launch lock and does not leave behind a differently configured broker that could block the next Codex agent.

## Security model at a glance

The default boundary is the MCP tool versus the private review page:

1. The agent reads a conversation and composes a draft.
2. `open_whatsapp_send_review` stages any initial attachment, opens a random-capability page on `127.0.0.1`, and returns immediately without sending.
3. You verify the linked sending number when available, then inspect and edit the recipient, group, text/caption, reply context, and attachment. You can inspect or remove the link preview; editing its source URL regenerates it. If Baileys has not retained a canonical phone JID, the page says the account number is unavailable rather than guessing.
4. Only the page's **Send on WhatsApp** button freezes that displayed revision and enters the single-use transport path. The editor is replaced by a sending indicator while WhatsApp is contacted.
5. Sent, failed, and uncertain outcomes replace the editor with a frozen summary of the attempted payload. Attachment bytes are cleaned immediately while safe filename/type/size metadata remains visible; an uncertain result is never retried automatically.

The review expires after ten minutes, permits at most one transport attempt, and never returns its route or action secret to MCP. There is no generic one-step or bulk-send tool. The legacy prepare/digest/send tools remain available for compatibility; that actual send tool keeps its destructive annotation and mandatory Codex prompt.

Inbound messages and attachments are **untrusted data, never agent instructions**. Do not allow a phone number, name, SQL fragment, URL, or instruction found inside message content to select records or drive another privileged MCP. Cross-system identity lookup must use only a machine-resolved `senderE164` field.

### Encrypted credentials, plaintext cache

Baileys linked-device credential payloads and Signal-key **values** are encrypted before they are written to SQLite. Each local profile uses AES-256-GCM with a random master key held in the operating system's native credential store. The file `credential-vault.json` contains only a non-secret vault identifier and format version, never the master key.

Some lookup metadata remains plaintext, including the paired/registered flag and Signal-key category and ID. Cached message text, downloaded media, staged drafts and media snapshots, configuration, and redacted audit/send records also remain plaintext under `~/.safe-whatsapp-mcp/`.

The server requests `0700` for directories and `0600` for files where the operating system supports those modes. Those permissions limit access to the plaintext cache; they are not encryption, and enforcement on Windows is best-effort. Use FileVault, BitLocker, LUKS, or equivalent full-disk encryption.

Credential encryption protects an offline copy of the state directory from yielding reusable WhatsApp auth secrets without the corresponding OS-vault key. It does not protect against malware running as your user, an administrator or root process, a compromised Node/agent runtime, or secrets already decrypted in process memory. Write access remains sensitive because a writer can delete, replay, or tamper with local state and prepared sends. Multiple local agents must access that state only through their authenticated proxies; do not share the directory itself with other users, repositories, backup utilities, or cloud-sync tools. See [SECURITY.md](SECURITY.md) before pairing a primary account.

## Requirements

- A phone with WhatsApp and permission to add a linked device
- A local MCP client that supports STDIO; automatic Codex setup currently targets macOS and Linux
- An available, unlocked native operating-system credential store
- The `codex` command on `PATH` when using `setup-codex`
- Either Node.js 22 or 24 for an npm/source installation, or a reviewed standalone bundle for your OS/architecture

An npm installation runs on the supported Node executable used during setup; keep that runtime installed at the same path and rerun `setup-codex` if that path changes. Reinstall the npm package after changing Node major versions. A standalone bundle includes its own pinned Node runtime, so its user does not install or select Node. This checkout includes an `.nvmrc` for Node `22.20.0` for source development and standalone builds. If you use `nvm`, run `nvm use` before `npm ci` and every development command. `better-sqlite3` is a native dependency, so an install made with one Node major version can fail under another.

[Baileys](https://github.com/WhiskeySockets/Baileys) is currently pinned to the `7.0.0-rc14` release candidate. Its protocol surface and maintenance status can change; upgrade it only after auth-state, history, identity, group, retry, browser-review, and send tests pass.

## Development setup

```bash
cd /absolute/path/to/a/reviewed/safe-whatsapp-mcp
nvm use # when using nvm
npm ci
npm run build
node dist/cli.js --help
```

This source-backed CLI is for development and testing. `setup-codex` intentionally refuses to register a source checkout, npm link, or ephemeral `npx` cache because its code can move or disappear underneath Codex. Use the global npm installation above or build the standalone bundle below for automatic registration. A stable project-local npm installation is accepted, but global installation is the supported simple path.

### Alternative: build a standalone bundle

On the build machine, run:

```bash
npm run build:standalone
npm run smoke:standalone
```

This creates `release/safewhatsapp-v<version>-<os>-<arch>/` plus a compressed archive on macOS and Linux. Keep the directory intact: its `safewhatsapp` launcher always invokes the private runtime beside it and never resolves `node` from `PATH`. The smoke check extracts the produced archive into a clean temporary directory, removes Node from `PATH`, and exercises the local SQLite-backed status command through both the direct and symlinked launcher.

To install a reviewed archive without Node or npm, extract its whole directory to a stable location and link only its launcher onto `PATH`. For example, set `bundle_name` to the archive name for your version and target:

```bash
bundle_name=safewhatsapp-v0.2.1-darwin-arm64
mkdir -p "$HOME/.local/lib/safewhatsapp" "$HOME/.local/bin"
tar -xzf "release/$bundle_name.tar.gz" -C "$HOME/.local/lib/safewhatsapp"
ln -sfn "$HOME/.local/lib/safewhatsapp/$bundle_name/safewhatsapp" "$HOME/.local/bin/safewhatsapp"
```

Ensure `$HOME/.local/bin` is on the MCP client's `PATH`. Do not copy the launcher by itself; it needs the adjacent `runtime/` and `app/` directories. A signed installer can perform these steps for public releases.

Release bundles are platform- and architecture-specific because `better-sqlite3` and the operating-system credential-store adapter are native modules. Build each supported macOS/Linux target on that target with the same Node executable used to install its production dependencies. Windows standalone packaging is not implemented yet. A publicly downloaded macOS release must still be signed and notarized; the local builder does not claim to do that without the maintainer's Apple credentials.

## Pair the linked device

```bash
safewhatsapp connect
```

The command opens a crisp QR in your default browser. On iPhone, scan it from **WhatsApp → Settings → Linked Devices → Link a Device**; on Android, use **WhatsApp → ⋮ → Linked devices → Link a device**. If the browser cannot be opened automatically, the terminal prints a short-lived local URL to open yourself.

The QR page binds only to `127.0.0.1` on an operating-system-selected port and uses a random 256-bit path token. The QR payload and PNG are not written to app state, temporary files, logs, audit data, MCP, or a remote service. They necessarily exist transiently in the Baileys/Node process, loopback HTTP response, and browser memory; owned PNG buffers are cleared on replacement/exit as a best effort. Responses are marked `no-store`. The document stays loaded while a token-protected same-origin poll updates only the QR image when WhatsApp rotates it. After the scan, the page removes the QR and shows the finishing state until the required credential save and WhatsApp socket restart succeed; it reports success only after the replacement socket opens. If the local process stops, the loaded page tells you to check the terminal instead of navigating to a browser error. Browser history may retain only the now-useless loopback URL.

When the command starts with an unpaired profile, it first clears any residual credentials, messages, downloaded media, pending sends, and audit data from a prior account. This happens under the state lock before fresh credentials are loaded; configuration and user-owned `outbox/` files are preserved. QR pairing persists the encrypted credentials before Baileys performs WhatsApp's mandatory post-scan reconnect, then waits up to two minutes for the final recent-history chunk to be ingested before disconnecting. Pending offline notifications and the first history chunk are not treated as completion. Full-history registration is deliberately disabled because the local cache is bounded and that mode is not accepted reliably by WhatsApp's current linked-device handshake. Later reads reconnect with the saved credentials. Normal shutdown never logs out or unpairs the device.

Useful local commands:

```bash
safewhatsapp status
safewhatsapp status --live
safewhatsapp setup-codex
safewhatsapp setup-codex --enable-send
safewhatsapp setup-codex --enable-send --enable-media-send
safewhatsapp serve
safewhatsapp disconnect
safewhatsapp purge --yes
safewhatsapp purge --yes --abandon-key # recovery only; see below
```

- `status` reads local state only; `status --live` performs a bounded connection check. Status reports credential encryption and plaintext cache storage separately as `credentialsAtRest` and `messageCacheAtRest`.
- `setup-codex` registers read/draft access in the user Codex configuration. `--enable-send` explicitly enables text sends, while adding `--enable-media-send` explicitly enables media sends too. The browser opener is auto-approved because it cannot itself send; the retained legacy send tool still prompts every time.
- `serve` runs a per-client STDIO proxy. It discovers or starts the single authenticated local broker that owns the database and on-demand WhatsApp session; it does not create another database writer or another WhatsApp connection.
- `disconnect` immediately sends a remote logout request when a paired local credential exists, then clears all local account-bound state and requests deletion of that profile's OS credential-vault key while preserving configuration and `outbox/`. Baileys does not provide a server acknowledgement for that request. If the remote request fails after credentials are loaded, local cleanup still completes and the command reports the failure. `unlink` remains an undocumented compatibility alias.
- `purge --yes` is **local-only**. It removes the encrypted credentials, requests deletion of their OS credential-vault key, and clears cache, downloaded inbound media, pending sends, audit data, and configuration while preserving `outbox/`; it does not log out WhatsApp. Run `disconnect` first when possible, or remove the device in WhatsApp's Linked Devices screen.
- If key deletion cannot be confirmed, normal purge retains the non-secret vault descriptor so cleanup can be retried. After the encrypted auth rows have been removed from the active state directory, `purge --yes --abandon-key` is the explicit recovery path: it discards that descriptor and permits re-pairing even if an orphaned wrapping key may remain in the OS credential store.

Credential-vault deletion is best effort because the native binding can suppress some operating-system errors. Use `--abandon-key` only after `credential_cleanup_incomplete` and only after removing retained copies of the matching state. Destructive cleanup also requires this package's private ownership marker, so it fails closed for an arbitrary directory. See [SECURITY.md](SECURITY.md#account-lifecycle-and-destructive-cleanup) for the complete cleanup and recovery model.

Commands that directly open or mutate the profile, including `connect`, `disconnect`, and `purge`, require exclusive ownership. Close every Codex client using Safe WhatsApp before running them if the CLI reports that the shared broker is active.

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

All proxies sharing a broker must use the exact same settings and `SAFE_WHATSAPP_MCP_ENABLE_SEND` / `SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND` values. A mismatch fails closed instead of inheriting another client's permissions. Close and restart all Safe WhatsApp Codex clients after changing the configuration, either send gate, or the installed version.

Tests or isolated local profiles may set `SAFE_WHATSAPP_MCP_STATE_DIR` to an absolute state-directory path. Do not point it at a repository, shared folder, cloud-synchronized directory, or a directory containing unrelated files.

## Configure Codex

Run setup from either the global npm installation or a reviewed standalone bundle:

```bash
safewhatsapp setup-codex                 # read and draft; sending off
safewhatsapp setup-codex --enable-send   # browser-reviewed text sending
safewhatsapp setup-codex --enable-send --enable-media-send
                                         # browser-reviewed text and media sending
```

This updates only `mcp_servers.safe_whatsapp` through Codex's atomic configuration API. It does not change the user's global model, sandbox, approval policy, or approval reviewer. A same-name server with a different command is treated as a conflict instead of being overwritten. Existing stricter server approval settings, disabled state, and tool deny list are preserved. For npm, setup pins the absolute installed Node and CLI paths; rerun it when either path changes. In-place upgrades at the same paths are picked up automatically. For standalone, rerun setup after installing a newer bundle so Codex follows the new verified launcher.

If an existing Safe WhatsApp entry is disabled, setup leaves it disabled and says so. Enable that entry in Codex before restarting if you want its tools loaded.

`--enable-media-send` is accepted only together with `--enable-send`. Either sending mode fails if effective Codex settings use `approval_policy = "never"` or route approvals to an automated reviewer. Project, profile, session, or managed configuration can still override the user configuration; review those layers if Codex reports the server as overridden.

Restart the Codex surface you use after setup. The ChatGPT desktop app, Codex CLI, and IDE extension on the same host share the MCP configuration, and concurrently open agents safely converge on the same ephemeral local broker.

For manual review or another machine, [examples/codex-config.toml](examples/codex-config.toml) shows the standalone server policy. Replace its launcher placeholder with the absolute path to a reviewed standalone `safewhatsapp`. For npm, prefer `setup-codex`, which safely records the absolute Node and installed CLI paths. Never configure Codex against `npx`, a `node` found only through `PATH`, a checkout's `dist/cli.js`, an npm link, or a standalone launcher copied without its adjacent bundle.

The example follows the current [official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp.md), including server-level and per-tool approval modes.

The important approval settings are shown below. The first two are global Codex settings, so review their effect on your other tools before changing them; `setup-codex` checks them but never changes them.

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

[mcp_servers.safe_whatsapp.tools.open_whatsapp_send_review]
approval_mode = "approve"

[mcp_servers.safe_whatsapp.tools.send_prepared_whatsapp_message]
approval_mode = "prompt"
```

`open_whatsapp_send_review` is explicitly approved because it cannot publish a WhatsApp message. It does open a local page that may perform the bounded public-site preview fetch described below. The later browser click invokes an internal send operation that is not an MCP tool call. `approval_policy = "on-request"` and a user reviewer still protect the retained `send_prepared_whatsapp_message` compatibility path, whose explicit rule forces a prompt and whose annotations remain destructive and open-world. Never automate the external review page with a browser or desktop-control tool; a click is a human boundary only while the agent cannot control that browser.

For another STDIO client, start from [examples/stdio-client.example.json](examples/stdio-client.example.json). It may invoke the review opener without an extra prompt, but it must not receive or control the private browser capability. Configure its equivalent of “always prompt” for the legacy send tool; if it cannot enforce that rule, disable the legacy tool or leave sending disabled.

## Sending controls

Sending is off unless explicitly enabled in the MCP server environment:

| Variable | Default | Effect |
| --- | --- | --- |
| `SAFE_WHATSAPP_MCP_ENABLE_SEND` | `false` | Allows prepared text sends and is also required for media sends. |
| `SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND` | `false` | Additionally allows prepared media sends. |

These flags are deployment kill switches, not approval for an individual message. The preferred flow is draft → private browser review → browser click → single-use send. The older prepare → exact preview → prompted legacy send flow remains supported.

Direct destinations must be canonical `+E.164` numbers and are verified with WhatsApp. The review page offers only locally named, cached existing groups through review-scoped opaque choices; every displayed group name includes a stable masked identifier, and an unknown or unnamed requested group fails closed. The page never accepts an editable transport JID. There is deliberately no send allowlist in `0.2.1`: after browser review or legacy approval, a send can target any verified direct number or reviewable existing group. Broadcasts, channels, status, and arbitrary raw JIDs are rejected.

The legacy approval preview visibly escapes bidirectional and other invisible Unicode formatting controls. The browser composer separately warns when message text contains bidirectional controls and shows an exact escaped rendering; group and filename labels escape those controls too. This keeps the bytes that will actually be sent inspectable without silently changing them.

For outbound media, first place the file in:

```text
~/.safe-whatsapp-mcp/outbox/
```

The media prepare and review tools initially accept only a relative path beneath that directory. Absolute paths, traversal, symlink escapes, non-regular files, and files over the configured limit (hard maximum 25 MiB) are rejected. The review page can replace that attachment only through its explicit file picker and bounded upload; it never accepts another filesystem path. Exact bytes are snapshotted into private pending storage and bound by hash. Each displayed attachment also has a random review revision that the browser must return on Send, so a stale duplicate tab cannot authorize different media. Images, video, audio, and documents are supported; audio captions are rejected because WhatsApp's audio payload does not carry them.

For a text-only draft, the page automatically loads a card for the first HTTP(S) or `www.` link. This contacts the linked site from your computer, so it may see your public IP address. Loading is visible; if a site temporarily fails, the page shows **Preview unavailable** with a manual retry instead of retrying in a loop. The card can be removed without changing the message, and no preview is loaded while a file is attached. Fetching is bounded to public addresses on ports 80/443, revalidates DNS and redirects, sends no cookies/auth/referrer, caps downloaded data, and converts accepted artwork to a small local JPEG. Editing the URL invalidates the card. The reviewed card—or an explicit `null`—is passed to Baileys so it cannot fetch a different preview during transport.

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
| `open_whatsapp_send_review` | Open an editable, private browser composer | May fetch the first linked public website for a preview; only the later browser button can send to WhatsApp |
| `send_prepared_whatsapp_message` | Send one immutable staged payload | **Yes; always approve** |
| `discard_prepared_whatsapp_message` | Remove one unsent staged payload | No; writes local state |

All cached direct and group conversations are readable. `0.2.1` has no read allowlist. Keep this in mind before giving an agent other privileged tools in the same conversation.

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
- The shared WhatsApp socket closes after 60 seconds of inactivity and reconnects on demand; closing one agent does not interrupt another attached agent.
- An open review keeps the broker alive after its initiating MCP client disconnects. It expires after ten minutes; terminal state remains briefly visible, then its capability and temporary media are removed.
- The server does not send presence, typing, or read receipts, and does not archive, mute, or otherwise mutate chats.
- Persistent database-backed WhatsApp message retry lookup is disabled, preventing reconnect-time relay of unrelated `fromMe` messages outside this package's staged-send path.
- Group sends do not reuse persisted participant metadata; Baileys fetches current group metadata before constructing a send.
- Group roster metadata is not retained at all; group events keep only the bounded chat title needed by the read/approval UI.
- Redacted send/audit metadata is retained for 30 days. Logs must not include message text, QR data, full phone/JID values, contact/group names, filenames, or auth material.

WhatsApp content is end-to-end encrypted in transit to the linked-device endpoint. When an MCP client sends that plaintext to a configured AI model, it has left the WhatsApp encryption boundary. Minimize the messages and media you provide to any model and understand that model provider's data controls.

## Scope exclusions

`0.2.1` does not support group administration, broadcasts, channels, status, reactions, outbound edit/delete, calls, location, contacts, polls, view-once sending, auto-replies, scheduled sends, or bulk sends.

## Development

```bash
npm run typecheck
npm test
npm run audit:prod
npm run pack:dry-run
npm run smoke:pack
npm run verify:release
```

Tests use injected fake sockets; they must not connect to WhatsApp. A live personal-account acceptance test is manual, opt-in, and runs only after automated security and packaging checks pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and license

Version `0.2.1` supports global npm installation as the primary onboarding path. There is no signed GitHub standalone release yet; locally built standalone bundles remain the Node-free alternative.

Licensed under the [MIT License](LICENSE). Use [GitHub Issues](https://github.com/dhruvratra/safe-whatsapp-mcp/issues) for non-sensitive bugs and feature requests, [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
