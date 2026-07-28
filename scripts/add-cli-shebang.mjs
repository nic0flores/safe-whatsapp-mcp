// Adds an executable shebang to generated CLI output while src/cli.ts keeps its required agent context note first.
import { chmod, readFile, writeFile } from "node:fs/promises";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const source = await readFile(cliPath, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  await writeFile(cliPath, `#!/usr/bin/env node\n${source}`, "utf8");
}
await chmod(cliPath, 0o755);
