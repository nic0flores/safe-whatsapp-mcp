import test from "node:test";
import assert from "node:assert/strict";
import {
  standaloneBundleName,
  standaloneExecutableName,
  standaloneLauncher,
} from "../scripts/standalone-layout.mjs";

test("standalone names are target-specific and reject path components", () => {
  assert.equal(
    standaloneBundleName("0.1.0", "darwin", "arm64"),
    "safewhatsapp-v0.1.0-darwin-arm64",
  );
  assert.throws(
    () => standaloneBundleName("0.1.0", "../darwin", "arm64"),
    /unsafe standalone target/iu,
  );
  assert.equal(standaloneExecutableName("darwin"), "safewhatsapp");
  assert.throws(() => standaloneExecutableName("win32"), /not implemented/u);
});

test("standalone launchers use only their private Node runtime", () => {
  const posix = standaloneLauncher("darwin");
  assert.match(posix, /runtime\/bin\/node/u);
  assert.match(posix, /app\/dist\/cli\.js/u);
  assert.match(posix, /SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE="\$bundle_dir\/safewhatsapp"/u);
  assert.match(posix, /SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE="\$bundle_dir"/u);
  assert.match(posix, /export SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE/u);
  assert.match(posix, /link_depth.*-gt 16/su);
  assert.equal(posix.includes("env node"), false);
  assert.throws(() => standaloneLauncher("win32"), /not implemented/u);
});
