import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const cli = path.resolve("dist/cli.js");

test("CLI exposes help/version and has an executable generated shebang", async () => {
  const source = await fs.readFile(cli, "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node\n"), true);
  assert.equal(source.includes("Baileys credentials and Signal-key values"), false);
  assert.equal(source.includes("Type UNLINK to continue"), false);
  assert.equal(source.includes("requirePhrase"), false);
  assert.match(source, /Scan the QR code opened in your browser/u);
  assert.match(source, /WhatsApp unlinked/u);
  assert.match(source, /MCP entry remains disabled/u);
  assert.equal(source.includes("LINK MY ACCOUNT"), false);
  assert.equal(source.includes("renderTerminalQr"), false);
  if (process.platform !== "win32") {
    assert.notEqual((await fs.stat(cli)).mode & 0o100, 0);
  }
  const help = await execFile(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /^safewhatsapp 0\.2\.0/mu);
  assert.match(help.stdout, /serve/u);
  assert.match(help.stdout, /setup-codex \[--enable-send\] \[--enable-media-send\]/u);
  assert.match(help.stdout, /disconnect/u);
  assert.match(help.stdout, /LOCAL-ONLY purge/u);
  assert.match(help.stdout, /clear account state/u);
  assert.doesNotMatch(help.stdout, /^\s+safewhatsapp broker\b/mu);
  const version = await execFile(process.execPath, [cli, "--version"]);
  assert.equal(version.stdout.trim(), "0.2.0");
  await assert.rejects(
    execFile(process.execPath, [cli, "unknown-command"]),
    (error) => {
      assert.match(error.stderr, /Run 'safewhatsapp --help'/u);
      return true;
    },
  );
  await assert.rejects(
    execFile(process.execPath, [cli, "setup-codex", "--enable-media-send"]),
    (error) => {
      assert.match(error.stderr, /setup-codex \[--enable-send\] \[--enable-media-send\]/u);
      assert.match(error.stderr, /invalid_arguments/u);
      return true;
    },
  );
  await assert.rejects(
    execFile(process.execPath, [cli, "setup-codex", "--enable-send", "--enable-send"]),
    (error) => {
      assert.match(error.stderr, /invalid_arguments/u);
      return true;
    },
  );
  const sourceEnvironment = { ...process.env };
  delete sourceEnvironment.SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE;
  delete sourceEnvironment.SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE;
  for (const flags of [
    ["--enable-send", "--enable-media-send"],
    ["--enable-media-send", "--enable-send"],
  ]) {
    await assert.rejects(
      execFile(process.execPath, [cli, "setup-codex", ...flags], { env: sourceEnvironment }),
      (error) => {
        assert.match(error.stderr, /installed_package_required/u);
        assert.doesNotMatch(error.stderr, /invalid_arguments/u);
        return true;
      },
    );
  }
});

test("disconnect runs directly without an interactive confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-unlink-"));
  try {
    const result = await execFile(process.execPath, [cli, "disconnect"], {
      env: {
        ...process.env,
        SAFE_WHATSAPP_MCP_STATE_DIR: path.join(root, "state"),
      },
    });
    assert.equal(result.stdout, "WhatsApp was already unlinked.\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex setup refuses a source checkout instead of registering mutable source", async () => {
  const env = { ...process.env };
  delete env.SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE;
  delete env.SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE;
  await assert.rejects(
    execFile(process.execPath, [cli, "setup-codex"], { env }),
    (error) => {
      assert.match(error.stderr, /installed from npm or as a reviewed standalone bundle/u);
      assert.match(error.stderr, /installed_package_required/u);
      return true;
    },
  );
});

test("a broken native credential-store binding stays behind the safe error boundary", async () => {
  const env = {
    ...process.env,
    NAPI_RS_NATIVE_LIBRARY_PATH: "/definitely/not/a/keyring.node",
  };
  const version = await execFile(process.execPath, [cli, "--version"], { env });
  assert.equal(version.stdout.trim(), "0.2.0");

  const keyStoreUrl = pathToFileURL(path.resolve("dist/auth/masterKeyStore.js")).href;
  const script = [
    `const { KeyringMasterKeyStore } = await import(${JSON.stringify(keyStoreUrl)});`,
    "try {",
    "  await new KeyringMasterKeyStore().get('00000000-0000-4000-8000-000000000000', 1);",
    "} catch (error) {",
    "  process.stderr.write(JSON.stringify({ code: error?.code, message: error?.message }));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n");
  await assert.rejects(
    execFile(process.execPath, ["--input-type=module", "--eval", script], { env }),
    (error) => {
      assert.deepEqual(JSON.parse(error.stderr), {
        code: "credential_store_unavailable",
        message: "The operating-system credential store is unavailable. Unlock it and retry.",
      });
      assert.equal(error.stderr.includes("/definitely/not"), false);
      assert.equal(error.stderr.includes(process.cwd()), false);
      return true;
    },
  );
});

test("offline status is structured and purge preserves only user outbox content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-cli-"));
  const state = path.join(root, "state");
  const env = {
    ...process.env,
    SAFE_WHATSAPP_MCP_STATE_DIR: state,
    SAFE_WHATSAPP_MCP_ENABLE_SEND: "false",
    SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND: "false",
  };
  const status = await execFile(process.execPath, [cli, "status"], { env });
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.paired, false);
  assert.equal(parsed.connected, false);
  assert.equal(parsed.credentialsAtRest, "aes-256-gcm+os-credential-vault");
  assert.equal(parsed.messageCacheAtRest, "plaintext-private-permissions");

  await fs.writeFile(path.join(state, "config.json"), "{}\n");
  await fs.writeFile(path.join(state, "audit.log"), "audit\n");
  await fs.mkdir(path.join(state, "outbox"), { recursive: true });
  await fs.writeFile(path.join(state, "outbox", "mine.txt"), "keep");
  const purged = await execFile(process.execPath, [cli, "purge", "--yes"], { env });
  assert.match(purged.stdout, /preserved/u);
  assert.match(purged.stdout, /LOCAL-ONLY PURGE/u);
  assert.match(purged.stdout, /does not log out WhatsApp/u);
  assert.match(purged.stdout, /Linked Devices/u);
  assert.match(purged.stdout, /OS credential-vault key/u);
  assert.match(purged.stdout, /requested deletion/u);
  assert.equal(await fs.readFile(path.join(state, "outbox", "mine.txt"), "utf8"), "keep");
  await assert.rejects(() => fs.access(path.join(state, "config.json")), /ENOENT/u);
  await assert.rejects(() => fs.access(path.join(state, "audit.log")), /ENOENT/u);

  const abandoned = await execFile(
    process.execPath,
    [cli, "purge", "--yes", "--abandon-key"],
    { env },
  );
  assert.match(abandoned.stdout, /discarded the non-secret retry descriptor/u);
});

test("pairing refuses a non-interactive process before producing a QR", async () => {
  await assert.rejects(
    execFile(process.execPath, [cli, "connect"]),
    (error) => {
      assert.match(error.stderr, /interactive local terminal/u);
      assert.equal(error.stdout.includes("Scan this QR"), false);
      return true;
    },
  );
});
