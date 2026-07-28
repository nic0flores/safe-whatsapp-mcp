// Agent context note: Removes only this checkout's generated dist directory before TypeScript emits fresh files. Tests: npm test and scripts/smoke-pack.mjs. Keep the deletion target fixed beneath the project root so stale compiled modules cannot ship; update this note after meaningful changes.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(projectRoot, "dist");
if (path.dirname(dist) !== projectRoot || path.basename(dist) !== "dist") {
  throw new Error("Refusing to clean an unexpected build path.");
}
await rm(dist, { recursive: true, force: true });
