// Agent context note: Converts native Node ABI loader failures into one actionable, redacted error for standalone users and source developers. Tests: test/core-native-dependency.test.mjs. Match only explicit NODE_MODULE_VERSION failures; update this note after meaningful changes.
import { SafeWhatsAppError } from "../errors.js";

export function normalizeNativeDependencyError(error: unknown): unknown {
  if (!isAbiMismatch(error)) return error;
  return new SafeWhatsAppError(
    "Native dependencies do not match this runtime. Reinstall the standalone bundle for this operating system and architecture. Source developers can run `npm rebuild better-sqlite3` in this checkout from the same terminal, then retry.",
    "native_module_version_mismatch",
  );
}

function isAbiMismatch(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ERR_DLOPEN_FAILED" &&
    error.message.includes("NODE_MODULE_VERSION") &&
    error.message.includes("different Node.js version");
}
