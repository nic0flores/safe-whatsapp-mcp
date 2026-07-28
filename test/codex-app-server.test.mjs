// Agent context note: Exercises the bounded Codex app-server JSONL config client with a fake peer. Production setup coverage lives in test/codex-setup.test.mjs; update this note after meaningful changes.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CodexAppServerConfigClient,
  CodexConfigRpcError,
} from "../dist/codex/appServerConfig.js";

const fixture = path.resolve("test/fixtures/fake-codex-app-server.mjs");

test("Codex app-server client completes the handshake and config requests", async () => {
  const client = await connect("normal");
  try {
    const read = await client.readConfig();
    assert.deepEqual(read, { config: {}, origins: {}, layers: [] });
    const written = await client.batchWrite({
      edits: [],
      filePath: "/tmp/config.toml",
      expectedVersion: "1",
      reloadUserConfig: false,
    });
    assert.equal(written.status, "ok");
  } finally {
    await client.close();
  }
});

test("Codex app-server client preserves only structured conflict metadata", async () => {
  const client = await connect("rpc-error");
  try {
    await assert.rejects(
      client.batchWrite({
        edits: [],
        filePath: "/tmp/config.toml",
        expectedVersion: "1",
        reloadUserConfig: false,
      }),
      (error) => {
        assert.equal(error instanceof CodexConfigRpcError, true);
        assert.equal(error.rpcCode, -32600);
        assert.equal(error.dataCode, "configVersionConflict");
        assert.equal(error.message.includes("secret parser details"), false);
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("Codex app-server client fails closed on malformed or timed-out peers", async () => {
  await assert.rejects(connect("malformed"), (error) => error.code === "codex_config_unavailable");
  await assert.rejects(connect("timeout", 30), (error) => error.code === "codex_config_unavailable");
});

test("Codex app-server client reports a missing Codex command safely", async () => {
  await assert.rejects(
    CodexAppServerConfigClient.connect({
      command: path.join(process.cwd(), "definitely-missing-codex"),
      args: [],
      cwd: process.cwd(),
      requestTimeoutMs: 100,
    }),
    (error) => error.code === "codex_cli_not_found" && !error.message.includes(process.cwd()),
  );
});

function connect(mode, requestTimeoutMs = 1_000) {
  return CodexAppServerConfigClient.connect({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    environment: { ...process.env, FAKE_CODEX_MODE: mode },
    requestTimeoutMs,
  });
}
