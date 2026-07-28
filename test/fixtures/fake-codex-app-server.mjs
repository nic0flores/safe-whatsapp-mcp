// Agent context note: Deterministic JSONL peer for test/codex-app-server.test.mjs. Keep modes small and never read a real Codex config; update this note after meaningful changes.
import readline from "node:readline";

const mode = process.env.FAKE_CODEX_MODE ?? "normal";
const input = readline.createInterface({ input: process.stdin });

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "timeout") return;
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, { userAgent: "fake-codex" });
    return;
  }
  if (request.method === "config/read") {
    respond(request.id, {
      config: {},
      origins: {},
      layers: [],
    });
    return;
  }
  if (request.method === "config/batchWrite" && mode === "rpc-error") {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      error: {
        code: -32600,
        message: "secret parser details",
        data: { config_write_error_code: "configVersionConflict" },
      },
    })}\n`);
    return;
  }
  if (request.method === "config/batchWrite") {
    respond(request.id, {
      status: "ok",
      version: "2",
      filePath: "/tmp/config.toml",
      overriddenMetadata: null,
    });
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
