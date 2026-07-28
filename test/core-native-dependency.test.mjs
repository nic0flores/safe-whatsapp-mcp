import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNativeDependencyError } from "../dist/storage/nativeDependencyError.js";

test("a native Node ABI mismatch becomes an actionable redacted error", () => {
  const mismatch = Object.assign(new Error(
    "The module /private/path/addon.node was compiled against a different Node.js version " +
    "using NODE_MODULE_VERSION 137. This version requires NODE_MODULE_VERSION 127.",
  ), { code: "ERR_DLOPEN_FAILED" });

  const normalized = normalizeNativeDependencyError(mismatch);
  assert.equal(normalized.code, "native_module_version_mismatch");
  assert.match(normalized.message, /Reinstall the standalone bundle/u);
  assert.match(normalized.message, /npm rebuild better-sqlite3/u);
  assert.equal(normalized.message.includes("/private/path"), false);
});

test("unrelated native failures remain available to the normal redaction boundary", () => {
  const unrelated = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
  assert.equal(normalizeNativeDependencyError(unrelated), unrelated);
});
