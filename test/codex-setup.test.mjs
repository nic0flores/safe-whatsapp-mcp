// Agent context note: Covers safe, atomic Codex registration orchestration and standalone self-verification. The JSONL transport itself is tested in test/codex-app-server.test.mjs; update this note after meaningful changes.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEDIA_SEND_ENABLED_ENV,
  SEND_ENABLED_ENV,
  STANDALONE_BUNDLE_ENV,
  STANDALONE_EXECUTABLE_ENV,
} from "../dist/constants.js";
import { CodexConfigRpcError } from "../dist/codex/appServerConfig.js";
import { resolveStandaloneExecutable } from "../dist/codex/selfExecutable.js";
import { setupCodex } from "../dist/codex/setupCodex.js";
import { WHATSAPP_TOOL_NAMES } from "../dist/mcp/tools.js";
import { standaloneLauncher } from "../scripts/standalone-layout.mjs";

test("fresh Codex setup is read-only by default and idempotent", async () => {
  const fixture = await setupFixture();
  try {
    const first = await setupCodex(fixture.options());
    assert.equal(first.changed, true);
    assert.equal(first.sendEnabled, false);
    assert.equal(fixture.client.writes.length, 1);
    const write = fixture.client.writes[0];
    assert.equal(write.expectedVersion, "v1");
    assert.equal(write.reloadUserConfig, false);
    assert.equal(write.edits.length, 1);
    assert.equal(write.edits[0].keyPath, "mcp_servers.safe_whatsapp");
    assert.equal(write.edits[0].mergeStrategy, "upsert");
    const server = fixture.server();
    assert.equal(server.command, fixture.executable);
    assert.deepEqual(server.args, ["serve"]);
    assert.deepEqual(server.enabled_tools, [...WHATSAPP_TOOL_NAMES]);
    assert.equal(server.env[SEND_ENABLED_ENV], "false");
    assert.equal(server.env[MEDIA_SEND_ENABLED_ENV], "false");
    assert.equal(server.tools.send_prepared_whatsapp_message.approval_mode, "prompt");
    assert.equal(server.default_tools_approval_mode, "writes");

    const second = await setupCodex(fixture.options());
    assert.equal(second.changed, false);
    assert.equal(fixture.client.writes.length, 1);
    await assertNoSetupArtifacts(fixture.codexHome);
  } finally {
    await fixture.cleanup();
  }
});

test("text sending requires explicit opt-in and human-routed Codex approvals", async () => {
  const fixture = await setupFixture();
  try {
    const enabled = await setupCodex(fixture.options({ enableSend: true }));
    assert.equal(enabled.sendEnabled, true);
    assert.equal(fixture.server().env[SEND_ENABLED_ENV], "true");
    assert.equal(fixture.server().env[MEDIA_SEND_ENABLED_ENV], "false");

    for (const unsafe of [
      { approval_policy: "never", approvals_reviewer: "user" },
      { approval_policy: "on-request", approvals_reviewer: "auto_review" },
      { approval_policy: "on-request", approvals_reviewer: "guardian_subagent" },
    ]) {
      const blocked = await setupFixture({ effectiveConfig: unsafe });
      try {
        await assert.rejects(
          setupCodex(blocked.options({ enableSend: true })),
          (error) => error.code === "human_approval_required",
        );
        assert.equal(blocked.client.writes.length, 0);
      } finally {
        await blocked.cleanup();
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

test("compatible entries preserve stricter and unrelated server settings", async () => {
  const fixture = await setupFixture();
  try {
    const alias = path.join(fixture.root, "launcher-alias");
    await fs.symlink(fixture.executable, alias);
    fixture.client.userConfig.mcp_servers = {
      safe_whatsapp: {
        command: alias,
        args: ["serve"],
        enabled: false,
        default_tools_approval_mode: "prompt",
        disabled_tools: ["get_whatsapp_media"],
        env: {
          [SEND_ENABLED_ENV]: "true",
          [MEDIA_SEND_ENABLED_ENV]: "false",
        },
      },
    };
    fixture.client.syncEffective();
    const result = await setupCodex(fixture.options());
    assert.equal(result.enabled, false);
    const server = fixture.server();
    assert.equal(server.enabled, false);
    assert.equal(server.default_tools_approval_mode, "prompt");
    assert.deepEqual(server.disabled_tools, ["get_whatsapp_media"]);
    assert.equal(server.command, fixture.executable);
    assert.equal(server.env[SEND_ENABLED_ENV], "false");
  } finally {
    await fixture.cleanup();
  }
});

test("Codex setup rejects server-name collisions without writing", async () => {
  const fixture = await setupFixture();
  try {
    const other = path.join(fixture.root, "other-launcher");
    await fs.writeFile(other, "other", { mode: 0o700 });
    fixture.client.userConfig.mcp_servers = {
      safe_whatsapp: { command: other, args: ["serve"] },
    };
    fixture.client.syncEffective();
    await assert.rejects(
      setupCodex(fixture.options()),
      (error) => error.code === "codex_registration_conflict",
    );
    assert.equal(fixture.client.writes.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("Codex setup safely replaces a recognized older standalone bundle", async () => {
  const fixture = await setupFixture();
  try {
    const oldExecutable = await createRecognizedBundle(fixture.root, "0.0.9");
    fixture.client.userConfig.mcp_servers = {
      safe_whatsapp: { command: oldExecutable, args: ["serve"] },
    };
    fixture.client.syncEffective();
    const upgraded = await setupCodex(fixture.options());
    assert.equal(upgraded.changed, true);
    assert.equal(fixture.server().command, fixture.executable);

    const tampered = await setupFixture();
    try {
      const fakeExecutable = await createRecognizedBundle(tampered.root, "0.0.8");
      await fs.writeFile(fakeExecutable, `# tampered\n${standaloneLauncher(process.platform)}`, {
        mode: 0o700,
      });
      tampered.client.userConfig.mcp_servers = {
        safe_whatsapp: { command: fakeExecutable, args: ["serve"] },
      };
      tampered.client.syncEffective();
      await assert.rejects(
        setupCodex(tampered.options()),
        (error) => error.code === "codex_registration_conflict",
      );
      assert.equal(tampered.client.writes.length, 0);
    } finally {
      await tampered.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("Codex setup canonicalizes allowed CODEX_HOME ancestor aliases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-codex-canonical-"));
  try {
    const realParent = path.join(root, "real-parent");
    const aliasParent = path.join(root, "alias-parent");
    const realHome = path.join(realParent, "codex-home");
    const aliasHome = path.join(aliasParent, "codex-home");
    const executable = path.join(root, "safewhatsapp");
    await fs.mkdir(realHome, { recursive: true, mode: 0o700 });
    await fs.symlink(realParent, aliasParent);
    await fs.writeFile(executable, "launcher", { mode: 0o700 });
    const canonicalHome = await fs.realpath(realHome);
    const client = new FakeConfigClient(canonicalHome, {
      approval_policy: "on-request",
      approvals_reviewer: "user",
    });
    const result = await setupCodex({
      environment: { ...process.env, CODEX_HOME: aliasHome },
      executable,
      createClient: async (cwd, environment) => {
        assert.equal(cwd, canonicalHome);
        assert.equal(environment.CODEX_HOME, canonicalHome);
        return client;
      },
    });
    assert.equal(result.configPath, path.join(canonicalHome, "config.toml"));
    assert.equal(client.writes.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex setup maps config races and detects external edits", async () => {
  const raced = await setupFixture();
  try {
    raced.client.writeError = new CodexConfigRpcError(-32600, "configVersionConflict");
    await assert.rejects(
      setupCodex(raced.options()),
      (error) => error.code === "codex_config_changed",
    );
  } finally {
    await raced.cleanup();
  }

  const edited = await setupFixture({ configContents: "# original\n" });
  try {
    edited.client.onFirstRead = async () => {
      await fs.writeFile(path.join(edited.codexHome, "config.toml"), "# external edit\n", { mode: 0o600 });
    };
    await assert.rejects(
      setupCodex(edited.options()),
      (error) => error.code === "codex_config_changed",
    );
    assert.equal(edited.client.writes.length, 0);
    assert.equal(
      await fs.readFile(path.join(edited.codexHome, "config.toml"), "utf8"),
      "# external edit\n",
    );
  } finally {
    await edited.cleanup();
  }
});

test("Codex setup rejects unsafe config paths before opening a client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-codex-path-"));
  try {
    const executable = path.join(root, "safewhatsapp");
    await fs.writeFile(executable, "launcher", { mode: 0o700 });
    const real = path.join(root, "real");
    const linked = path.join(root, "linked");
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, linked);
    await assert.rejects(
      setupCodex({
        environment: { ...process.env, CODEX_HOME: linked },
        executable,
        createClient: async () => { throw new Error("must not run"); },
      }),
      (error) => error.code === "unsafe_codex_config_path",
    );

    const hardlinkHome = path.join(root, "hardlink-home");
    await fs.mkdir(hardlinkHome, { mode: 0o700 });
    const outside = path.join(root, "outside.toml");
    await fs.writeFile(outside, "# shared\n", { mode: 0o600 });
    await fs.link(outside, path.join(hardlinkHome, "config.toml"));
    await assert.rejects(
      setupCodex({
        environment: { ...process.env, CODEX_HOME: hardlinkHome },
        executable,
        createClient: async () => { throw new Error("must not run"); },
      }),
      (error) => error.code === "unsafe_codex_config_path",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex setup recovers an old partial lock but not a fresh competing lock", async () => {
  const stale = await setupFixture();
  try {
    const lockPath = path.join(stale.codexHome, ".safe-whatsapp-codex-setup.lock");
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    const result = await setupCodex(stale.options());
    assert.equal(result.changed, true);
    await assertNoSetupArtifacts(stale.codexHome);
  } finally {
    await stale.cleanup();
  }

  const fresh = await setupFixture();
  try {
    const lockPath = path.join(fresh.codexHome, ".safe-whatsapp-codex-setup.lock");
    await fs.writeFile(lockPath, "", { mode: 0o600 });
    await assert.rejects(
      setupCodex(fresh.options()),
      (error) => error.code === "codex_setup_locked",
    );
    assert.equal(fresh.client.writes.length, 0);
  } finally {
    await fresh.cleanup();
  }
});

test("standalone executable handoff accepts only its verified private bundle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-standalone-self-"));
  try {
    const bundle = path.join(root, "bundle");
    const executable = path.join(bundle, "safewhatsapp");
    const runtime = path.join(bundle, "runtime", "bin", "node");
    const modulePath = path.join(bundle, "app", "dist", "codex", "selfExecutable.js");
    await fs.mkdir(path.dirname(runtime), { recursive: true, mode: 0o755 });
    await fs.mkdir(path.dirname(modulePath), { recursive: true, mode: 0o755 });
    await fs.writeFile(executable, "launcher", { mode: 0o755 });
    await fs.writeFile(runtime, "runtime", { mode: 0o755 });
    await fs.writeFile(modulePath, "module", { mode: 0o644 });
    await fs.writeFile(path.join(bundle, "BUNDLE.json"), `${JSON.stringify({
      name: "safewhatsapp",
      version: "0.1.0",
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    })}\n`, { mode: 0o644 });
    const environment = {
      ...process.env,
      [STANDALONE_EXECUTABLE_ENV]: executable,
      [STANDALONE_BUNDLE_ENV]: bundle,
    };
    assert.equal(await resolveStandaloneExecutable({
      environment,
      modulePath,
      runtimePath: runtime,
    }), await fs.realpath(executable));

    await fs.chmod(executable, 0o775);
    await assert.rejects(
      resolveStandaloneExecutable({ environment, modulePath, runtimePath: runtime }),
      (error) => error.code === "unsafe_standalone_install",
    );
    await assert.rejects(
      resolveStandaloneExecutable({ environment: {} }),
      (error) => error.code === "standalone_install_required",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setupFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-codex-setup-"));
  const codexHome = path.join(root, "codex-home");
  const executablePath = path.join(root, "safewhatsapp");
  await fs.mkdir(codexHome, { mode: 0o700 });
  await fs.writeFile(executablePath, "launcher", { mode: 0o700 });
  const executable = await fs.realpath(executablePath);
  if (options.configContents !== undefined) {
    await fs.writeFile(path.join(codexHome, "config.toml"), options.configContents, { mode: 0o600 });
  }
  const client = new FakeConfigClient(
    codexHome,
    options.effectiveConfig ?? { approval_policy: "on-request", approvals_reviewer: "user" },
  );
  return {
    root,
    codexHome,
    executable,
    client,
    options: (extra = {}) => ({
      environment: { ...process.env, CODEX_HOME: codexHome },
      executable,
      createClient: async () => client,
      ...extra,
    }),
    server: () => client.userConfig.mcp_servers.safe_whatsapp,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function createRecognizedBundle(root, version) {
  const bundle = path.join(root, `safewhatsapp-v${version}-${process.platform}-${process.arch}`);
  const executable = path.join(bundle, "safewhatsapp");
  const runtime = path.join(bundle, "runtime", "bin", "node");
  const cli = path.join(bundle, "app", "dist", "cli.js");
  const self = path.join(bundle, "app", "dist", "codex", "selfExecutable.js");
  await fs.mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(self), { recursive: true, mode: 0o700 });
  await fs.writeFile(executable, standaloneLauncher(process.platform), { mode: 0o700 });
  await fs.writeFile(runtime, "runtime", { mode: 0o700 });
  await fs.writeFile(cli, "cli", { mode: 0o600 });
  await fs.writeFile(self, "self", { mode: 0o600 });
  await fs.writeFile(path.join(bundle, "app", "package.json"), `${JSON.stringify({
    name: "safe-whatsapp-mcp",
    version,
    type: "module",
    bin: { safewhatsapp: "dist/cli.js" },
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(bundle, "BUNDLE.json"), `${JSON.stringify({
    name: "safewhatsapp",
    version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  })}\n`, { mode: 0o600 });
  return executable;
}

class FakeConfigClient {
  constructor(codexHome, effectiveBase) {
    this.codexHome = codexHome;
    this.effectiveBase = structuredClone(effectiveBase);
    this.userConfig = {};
    this.version = "v1";
    this.writes = [];
    this.reads = 0;
    this.writeError = undefined;
    this.onFirstRead = undefined;
    this.syncEffective();
  }

  syncEffective() {
    this.effective = deepMerge(structuredClone(this.effectiveBase), this.userConfig);
  }

  async readConfig() {
    this.reads += 1;
    if (this.reads === 1) await this.onFirstRead?.();
    return {
      config: structuredClone(this.effective),
      origins: {},
      layers: [{
        name: { type: "user", file: path.join(this.codexHome, "config.toml"), profile: null },
        version: this.version,
        config: structuredClone(this.userConfig),
        disabledReason: null,
      }],
    };
  }

  async batchWrite(params) {
    if (this.writeError) throw this.writeError;
    this.writes.push(structuredClone(params));
    assert.equal(params.expectedVersion, this.version);
    const desired = params.edits[0].value;
    this.userConfig.mcp_servers ??= {};
    this.userConfig.mcp_servers.safe_whatsapp = deepMerge(
      this.userConfig.mcp_servers.safe_whatsapp ?? {},
      desired,
    );
    this.version = `v${this.writes.length + 1}`;
    this.syncEffective();
    return {
      status: "ok",
      version: this.version,
      filePath: path.join(this.codexHome, "config.toml"),
      overriddenMetadata: null,
    };
  }

  async close() {}
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const existing = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = deepMerge(existing, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}

async function assertNoSetupArtifacts(codexHome) {
  const entries = await fs.readdir(codexHome);
  assert.equal(entries.some((entry) => entry.includes("safe-whatsapp-codex-setup")), false);
}
