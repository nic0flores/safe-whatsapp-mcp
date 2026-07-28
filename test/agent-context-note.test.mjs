import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every TypeScript source starts with an agent context note", async () => {
  const files = await sourceFiles(path.join(projectRoot, "src"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const firstLine = (await fs.readFile(file, "utf8")).split(/\r?\n/u, 1)[0];
    assert.match(firstLine, /^\/\/ Agent context note:/u, path.relative(projectRoot, file));
  }
});

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  }));
  return nested.flat();
}
