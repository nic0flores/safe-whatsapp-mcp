// Agent context note: Builds a platform-specific safewhatsapp directory with its own Node runtime and production dependencies. Tests: test/standalone-layout.test.mjs and scripts/smoke-standalone.mjs. The runtime and native addons must be installed by the same Node executable; update this note after meaningful changes.
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertStandalonePlatform,
  standaloneBundleName,
  standaloneExecutableName,
  standaloneLauncher,
} from "./standalone-layout.mjs";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
assertStandalonePlatform(process.platform);
const requiredNode = `v${(await readFile(path.join(projectRoot, ".nvmrc"), "utf8")).trim().replace(/^v/u, "")}`;
if (process.version !== requiredNode) {
  throw new Error(`Standalone releases require Node ${requiredNode}; current runtime is ${process.version}.`);
}
const bundleName = standaloneBundleName(packageJson.version, process.platform, process.arch);
const finalBundle = path.join(releaseRoot, bundleName);
const archive = path.join(releaseRoot, `${bundleName}.tar.gz`);

if (!path.isAbsolute(process.execPath)) throw new Error("The build Node executable is not absolute.");
if (!process.env.npm_execpath) {
  throw new Error("Run this builder through `npm run build:standalone`.");
}

await prepareReleaseRoot();
const temporaryRoot = await mkdtemp(path.join(releaseRoot, ".standalone-build-"));
const stagedBundle = path.join(temporaryRoot, bundleName);

try {
  const appRoot = path.join(stagedBundle, "app");
  const runtimeRoot = path.join(stagedBundle, "runtime");
  const runtimeBin = path.join(runtimeRoot, "bin/node");
  await mkdir(appRoot, { recursive: true, mode: 0o755 });
  await mkdir(path.dirname(runtimeBin), { recursive: true, mode: 0o755 });

  for (const name of [
    "package.json",
    "npm-shrinkwrap.json",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    await copyFile(path.join(projectRoot, name), path.join(appRoot, name));
  }
  await cp(path.join(projectRoot, "dist"), path.join(appRoot, "dist"), { recursive: true });
  const examplesRoot = path.join(appRoot, "examples");
  await mkdir(examplesRoot, { mode: 0o755 });
  for (const name of [
    "codex-config.toml",
    "config.example.json",
    "stdio-client.example.json",
  ]) {
    await copyFile(path.join(projectRoot, "examples", name), path.join(examplesRoot, name));
  }

  const nodeBinDir = path.dirname(process.execPath);
  await run(process.execPath, [
    process.env.npm_execpath,
    "ci",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ], {
    cwd: appRoot,
    env: {
      ...process.env,
      PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      npm_node_execpath: process.execPath,
    },
  });

  await copyFile(process.execPath, runtimeBin);
  await chmod(runtimeBin, 0o755);
  await copyNodeLicense(runtimeRoot);

  const launcherPath = path.join(stagedBundle, standaloneExecutableName(process.platform));
  await writeFile(launcherPath, standaloneLauncher(process.platform), { mode: 0o755 });
  await chmod(launcherPath, 0o755);
  await writeFile(path.join(stagedBundle, "BUNDLE.json"), `${JSON.stringify({
    name: "safewhatsapp",
    version: packageJson.version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  }, null, 2)}\n`, { mode: 0o644 });

  await rm(finalBundle, { recursive: true, force: true });
  await rename(stagedBundle, finalBundle);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

await rm(archive, { force: true });
const tar = await firstExisting(["/usr/bin/tar", "/bin/tar"]);
await run(tar, ["-czf", archive, "-C", releaseRoot, bundleName]);

process.stdout.write(
  `Standalone bundle: ${finalBundle}\n` +
  `Archive: ${archive}\n` +
  "Run `npm run smoke:standalone` before distribution. Release downloads still require platform signing/notarization.\n",
);

async function copyNodeLicense(runtimeRoot) {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "..", "LICENSE"),
    path.resolve(path.dirname(process.execPath), "..", "NODE-LICENSE"),
    path.join(path.dirname(process.execPath), "LICENSE"),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        await copyFile(candidate, path.join(runtimeRoot, "NODE-LICENSE"));
        return;
      }
    } catch {
      // Try the next standard Node distribution layout.
    }
  }
  throw new Error("Could not find the bundled Node runtime license.");
}

async function prepareReleaseRoot() {
  try {
    const existing = await lstat(releaseRoot);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("The standalone release root must be a real directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(releaseRoot, { mode: 0o755 });
  }
  const [realProject, realRelease] = await Promise.all([
    realpath(projectRoot),
    realpath(releaseRoot),
  ]);
  if (path.dirname(realRelease) !== realProject || path.basename(realRelease) !== "release") {
    throw new Error("The standalone release root escapes the project.");
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next standard system path.
    }
  }
  throw new Error("Could not find the system tar executable.");
}

async function run(command, args, options = {}) {
  await execFile(command, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
    ...options,
  });
}
