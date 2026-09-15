// Agent context note: Provides pairing, read-only Codex setup, status, broker-proxied STDIO serve, direct disconnect, and guarded purge commands. Tests: CLI, broker, Codex setup, browser QR, account lifecycle, and package smoke. V1 exposes no CLI path that enables WhatsApp sending.
import process from "node:process";
import { SafeWhatsAppApplication } from "./application.js";
import {
  withBrokerStateTakeover,
} from "./broker/exclusive.js";
import { serveThroughBroker } from "./broker/proxy.js";
import { runLocalBroker } from "./broker/server.js";
import { getCliStatus } from "./broker/status.js";
import { setupCodex } from "./codex/setupCodex.js";
import { ConfigLoader } from "./config/config.js";
import { CLI_NAME, PACKAGE_NAME, VERSION } from "./constants.js";
import { SafeWhatsAppError, publicError } from "./errors.js";
import { BrowserQrDisplay } from "./qr/browserQr.js";
import { StatePaths } from "./storage/paths.js";
import { purgeLocalState, WhatsAppCore } from "./whatsapp/core.js";

const args = process.argv.slice(2);

try {
  await run(args);
} catch (error) {
  const failure = publicError(error);
  process.stderr.write(`${PACKAGE_NAME}: ${failure.message} (${failure.code})\n`);
  process.exitCode = 1;
}

async function run(input: string[]): Promise<void> {
  const [command, ...rest] = input;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    assertNoArguments(rest);
    process.stdout.write(helpText());
    return;
  }
  if (command === "--version" || command === "-v") {
    assertNoArguments(rest);
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  switch (command) {
    case "connect":
      assertNoArguments(rest);
      await connectCommand();
      return;
    case "setup-codex":
      await setupCodexCommand(rest);
      return;
    case "status":
      await statusCommand(rest);
      return;
    case "serve":
      assertNoArguments(rest);
      await serveCommand();
      return;
    case "broker":
      if (rest.length > 0 && !(rest.length === 1 && rest[0] === "--parented")) {
        throw invalidArguments("broker");
      }
      await runLocalBroker({ parented: rest[0] === "--parented" });
      return;
    case "disconnect":
    case "unlink":
      assertNoArguments(rest);
      await unlinkCommand();
      return;
    case "purge":
      await purgeCommand(rest);
      return;
    default:
      throw new SafeWhatsAppError(
        `Unknown command '${cleanArgument(command)}'. Run '${CLI_NAME} --help'.`,
        "invalid_command",
      );
  }
}

async function setupCodexCommand(input: string[]): Promise<void> {
  if (input.length > 0) throw invalidArguments("setup-codex");
  const configured = await setupCodex();
  const state = configured.changed ? "configured" : "already configured";
  process.stdout.write(
    `Codex is ${state} for Safe WhatsApp in hardened read-only mode. Sending is disabled.\n` +
    (configured.enabled
      ? "Restart Codex to load the WhatsApp tools.\n"
      : "The existing Safe WhatsApp MCP entry remains disabled. Enable it in Codex before restarting.\n"),
  );
}

async function connectCommand(): Promise<void> {
  requireInteractiveTerminal();
  const paths = new StatePaths();
  await withBrokerStateTakeover(paths, () => connectWithExclusiveState(paths));
}

async function connectWithExclusiveState(paths: StatePaths): Promise<void> {
  let qrDisplay: BrowserQrDisplay | undefined;
  let qrUpdates = Promise.resolve();
  let qrDisplayError: unknown;
  let rejectQrDisplay!: (error: unknown) => void;
  const qrDisplayFailure = new Promise<never>((_resolve, reject) => {
    rejectQrDisplay = reject;
  });
  let acceptQr = true;
  let displayNoticeShown = false;
  let pairingAcceptedNoticeShown = false;
  const application = await SafeWhatsAppApplication.open({
    paths,
    connectionTimeoutMs: 300_000,
    syncTimeoutMs: 120_000,
    clearResidualIfUnpaired: true,
    onQr: (qr) => {
      if (!acceptQr) return;
      qrUpdates = qrUpdates.then(async () => {
        if (!acceptQr) return;
        qrDisplay ??= await BrowserQrDisplay.start();
        const result = await qrDisplay.show(qr);
        if (displayNoticeShown) return;
        displayNoticeShown = true;
        process.stdout.write(result.browserOpened
          ? "Scan the QR code opened in your browser.\n"
          : `Open this local QR page: ${result.url}\n`);
      }).catch((error: unknown) => {
        qrDisplayError ??= error;
        rejectQrDisplay(error);
      });
    },
    onPairingAccepted: () => {
      if (!acceptQr) return;
      qrUpdates = qrUpdates.then(async () => {
        if (!acceptQr) return;
        await qrDisplay?.pairingAccepted();
        if (pairingAcceptedNoticeShown) return;
        pairingAcceptedNoticeShown = true;
        process.stdout.write("QR scanned. Connecting…\n");
      }).catch((error: unknown) => {
        qrDisplayError ??= error;
        rejectQrDisplay(error);
      });
    },
  });
  try {
    if (application.core.client.status().paired) {
      process.stdout.write("WhatsApp already linked. Syncing…\n");
    }
    const syncCompleteness = await Promise.race([
      application.core.sessions.connect(),
      qrDisplayFailure,
    ]);
    acceptQr = false;
    await qrUpdates;
    if (qrDisplayError) throw qrDisplayError;
    if (!application.core.client.status().paired) {
      throw new SafeWhatsAppError("Pairing did not complete.", "pairing_incomplete");
    }
    await qrDisplay?.finish().catch(() => undefined);
    const syncMessage = syncCompleteness === "complete"
      ? "WhatsApp connected."
      : "WhatsApp connected; message sync is incomplete.";
    process.stdout.write(`${syncMessage}\n`);
  } catch (error) {
    acceptQr = false;
    await qrUpdates.catch(() => undefined);
    await qrDisplay?.fail().catch(() => qrDisplay?.close()).catch(() => undefined);
    await application.close().catch(() => undefined);
    throw error;
  }
  await application.close();
}

async function statusCommand(input: string[]): Promise<void> {
  const live = input.length === 1 && input[0] === "--live";
  if (input.length > 0 && !live) throw invalidArguments("status [--live]");
  const paths = new StatePaths();
  const status = await getCliStatus(paths, live);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function serveCommand(): Promise<void> {
  await serveThroughBroker();
}

async function unlinkCommand(): Promise<void> {
  const paths = new StatePaths();
  const result = await withBrokerStateTakeover(paths, async () => {
    const config = await new ConfigLoader(paths).load();
    const core = await WhatsAppCore.open(paths, config, { connectionTimeoutMs: 60_000 });
    try {
      return await core.unlink();
    } finally {
      await core.close();
    }
  });
  if (result.remoteLogout === "unconfirmed") {
    throw new SafeWhatsAppError(
      "Local account state was cleared, but WhatsApp did not confirm remote logout. Remove this device in WhatsApp → Settings → Linked Devices on your phone.",
      "remote_logout_unconfirmed",
    );
  }
  process.stdout.write(result.remoteLogout === "requested"
    ? "WhatsApp unlinked.\n"
    : "WhatsApp was already unlinked.\n");
}

async function purgeCommand(input: string[]): Promise<void> {
  const abandonCredentialKey = input.length === 2 &&
    input[0] === "--yes" && input[1] === "--abandon-key";
  if (!abandonCredentialKey && (input.length !== 1 || input[0] !== "--yes")) {
    throw invalidArguments("purge --yes [--abandon-key]");
  }
  const paths = new StatePaths();
  await withBrokerStateTakeover(paths, () =>
    purgeLocalState(paths, { abandonCredentialKey }));
  const keyCleanup = abandonCredentialKey
    ? "requested deletion of its OS credential-vault key and discarded the non-secret retry descriptor if deletion could not be confirmed"
    : "requested deletion of its OS credential-vault key";
  process.stdout.write(
    `LOCAL-ONLY PURGE: removed Safe WhatsApp MCP state under ${paths.display()}, ${keyCleanup}; preserved ${paths.display(paths.outboxDir)}. This does not log out WhatsApp. Unlink first when possible, or remove this device in WhatsApp → Settings → Linked Devices on your phone.\n`,
  );
}

function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SafeWhatsAppError(
      "This command requires an interactive local terminal.",
      "interactive_terminal_required",
    );
  }
}

function assertNoArguments(input: string[]): void {
  if (input.length > 0) throw new SafeWhatsAppError("This command takes no arguments.", "invalid_arguments");
}

function invalidArguments(usage: string): SafeWhatsAppError {
  return new SafeWhatsAppError(`Usage: ${CLI_NAME} ${usage}`, "invalid_arguments");
}

function cleanArgument(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 80);
}

function helpText(): string {
  return `${CLI_NAME} ${VERSION}\n\n` +
    "Local read-only MCP access to a personal WhatsApp linked device.\n\n" +
    "Usage:\n" +
    `  ${CLI_NAME} connect          Pair in a private local browser page, or check the link\n` +
    `  ${CLI_NAME} setup-codex      Register the hardened read-only MCP with Codex\n` +
    `  ${CLI_NAME} status [--live]  Show local status; optionally check WhatsApp live\n` +
    `  ${CLI_NAME} serve            Run the STDIO MCP server\n` +
    `  ${CLI_NAME} disconnect       Log out and clear account state; preserve config/outbox\n` +
    `  ${CLI_NAME} purge --yes [--abandon-key]\n` +
    "                               LOCAL-ONLY purge; does not log out; preserve outbox\n" +
    `  ${CLI_NAME} --version        Print the version\n`;
}
