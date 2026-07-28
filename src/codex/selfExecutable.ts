// Agent context note: Proves Codex setup is running from the reviewed standalone bundle and recognizes older exact standalone layouts for safe config upgrades. Tests: test/codex-setup.test.mjs and scripts/smoke-standalone.mjs. Never run an old bundle or fall back to node, dist/cli.js, PATH lookup, or an unverified launcher; update this note after meaningful changes.
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_NAME,
  STANDALONE_BUNDLE_ENV,
  STANDALONE_EXECUTABLE_ENV,
  VERSION,
} from "../constants.js";
import { SafeWhatsAppError } from "../errors.js";

interface BundleRecord {
  name?: unknown;
  version?: unknown;
  platform?: unknown;
  arch?: unknown;
  node?: unknown;
}

interface PackageRecord {
  name?: unknown;
  version?: unknown;
  type?: unknown;
  bin?: unknown;
}

const RECOGNIZED_LAUNCHER_HASHES = new Set([
  "8c9f4809dfccc9065e18e387bf8fc746b80e4ddaa18125d432312cf33e1b4f3f",
]);

export interface StandaloneExecutableOptions {
  environment?: NodeJS.ProcessEnv;
  modulePath?: string;
  runtimePath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
  uid?: number;
}

export async function resolveStandaloneExecutable(
  options: StandaloneExecutableOptions = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const executableValue = environment[STANDALONE_EXECUTABLE_ENV];
  const bundleValue = environment[STANDALONE_BUNDLE_ENV];
  if (!executableValue || !bundleValue) throw standaloneRequired();
  if (!path.isAbsolute(executableValue) || !path.isAbsolute(bundleValue)) throw unsafeBundle();

  const suppliedBundle = path.resolve(bundleValue);
  const suppliedExecutable = path.resolve(executableValue);
  if (suppliedBundle === path.parse(suppliedBundle).root ||
      suppliedExecutable !== path.join(suppliedBundle, "safewhatsapp")) {
    throw unsafeBundle();
  }

  const modulePath = path.resolve(options.modulePath ?? fileURLToPath(import.meta.url));
  const runtimePath = path.resolve(options.runtimePath ?? process.execPath);
  await Promise.all([
    assertSafePath(suppliedBundle, "directory", options.uid),
    assertSafePath(suppliedExecutable, "executable", options.uid),
  ]);
  const [bundle, executable] = await Promise.all([
    fs.realpath(suppliedBundle),
    fs.realpath(suppliedExecutable),
  ]).catch(() => { throw unsafeBundle(); });
  const expectedModule = path.join(bundle, "app", "dist", "codex", "selfExecutable.js");
  const expectedRuntime = path.join(bundle, "runtime", "bin", "node");
  const bundleRecordPath = path.join(bundle, "BUNDLE.json");
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);

  await Promise.all([
    assertSafePath(bundle, "directory", uid),
    assertSafePath(executable, "executable", uid),
    assertSafePath(expectedRuntime, "executable", uid),
    assertSafePath(bundleRecordPath, "file", uid),
  ]);
  const [realModule, realRuntime, realExecutable] = await Promise.all([
    fs.realpath(modulePath),
    fs.realpath(runtimePath),
    fs.realpath(executable),
  ]).catch(() => { throw unsafeBundle(); });
  if (realModule !== expectedModule || realRuntime !== expectedRuntime || realExecutable !== executable) {
    throw unsafeBundle();
  }

  let record: BundleRecord;
  try {
    record = JSON.parse(await fs.readFile(bundleRecordPath, "utf8")) as BundleRecord;
  } catch {
    throw unsafeBundle();
  }
  if (record.name !== "safewhatsapp" ||
      record.version !== (options.version ?? VERSION) ||
      record.platform !== (options.platform ?? process.platform) ||
      record.arch !== (options.arch ?? process.arch) ||
      record.node !== process.version) {
    throw unsafeBundle();
  }
  return executable;
}

export async function isRecognizedStandaloneExecutable(
  executableValue: string,
  options: Pick<StandaloneExecutableOptions, "platform" | "arch" | "uid"> = {},
): Promise<boolean> {
  try {
    if (!path.isAbsolute(executableValue)) return false;
    const executable = await fs.realpath(path.resolve(executableValue));
    if (path.basename(executable) !== "safewhatsapp") return false;
    const bundle = path.dirname(executable);
    if (bundle === path.parse(bundle).root) return false;

    const runtime = path.join(bundle, "runtime", "bin", "node");
    const app = path.join(bundle, "app");
    const dist = path.join(app, "dist");
    const codexDist = path.join(dist, "codex");
    const runtimeRoot = path.join(bundle, "runtime");
    const runtimeBin = path.join(runtimeRoot, "bin");
    const bundleRecordPath = path.join(bundle, "BUNDLE.json");
    const packagePath = path.join(app, "package.json");
    const cliPath = path.join(dist, "cli.js");
    const selfPath = path.join(codexDist, "selfExecutable.js");
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    await Promise.all([
      assertSafePath(bundle, "directory", uid),
      assertSafePath(app, "directory", uid),
      assertSafePath(dist, "directory", uid),
      assertSafePath(codexDist, "directory", uid),
      assertSafePath(runtimeRoot, "directory", uid),
      assertSafePath(runtimeBin, "directory", uid),
      assertSafePath(executable, "executable", uid),
      assertSafePath(runtime, "executable", uid),
      assertSafePath(bundleRecordPath, "file", uid),
      assertSafePath(packagePath, "file", uid),
      assertSafePath(cliPath, "file", uid),
      assertSafePath(selfPath, "file", uid),
    ]);

    const [record, packageRecord] = await Promise.all([
      readJsonRecord<BundleRecord>(bundleRecordPath),
      readJsonRecord<PackageRecord>(packagePath),
    ]);
    const launcher = await readBounded(executable, 16 * 1024);
    const launcherHash = createHash("sha256").update(launcher).digest("hex");
    if (!RECOGNIZED_LAUNCHER_HASHES.has(launcherHash)) return false;
    if (!hasExactKeys(record, ["arch", "name", "node", "platform", "version"])) return false;
    return record.name === "safewhatsapp" &&
      typeof record.version === "string" && isOlderPackageVersion(record.version, VERSION) &&
      record.platform === (options.platform ?? process.platform) &&
      record.arch === (options.arch ?? process.arch) &&
      typeof record.node === "string" && isSupportedNode(record.node) &&
      packageRecord.name === PACKAGE_NAME && packageRecord.version === record.version &&
      packageRecord.type === "module" &&
      isRecord(packageRecord.bin) && packageRecord.bin.safewhatsapp === "dist/cli.js";
  } catch {
    return false;
  }
}

async function readJsonRecord<T>(target: string): Promise<T> {
  const value: unknown = JSON.parse((await readBounded(target, 64 * 1024)).toString("utf8"));
  if (!isRecord(value)) throw unsafeBundle();
  return value as T;
}

async function readBounded(target: string, limit: number): Promise<Buffer> {
  const info = await fs.stat(target);
  if (info.size > limit) throw unsafeBundle();
  const value = await fs.readFile(target);
  if (value.length > limit) throw unsafeBundle();
  return value;
}

function isOlderPackageVersion(value: string, current: string): boolean {
  const candidate = parseVersion(value);
  const installed = parseVersion(current);
  if (!candidate || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate.numbers[index] !== installed.numbers[index]) {
      return candidate.numbers[index] < installed.numbers[index];
    }
  }
  return candidate.preRelease !== undefined && installed.preRelease === undefined;
}

function parseVersion(value: string): { numbers: [number, number, number]; preRelease?: string } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { preRelease: match[4] } : {}),
  };
}

function isSupportedNode(value: string): boolean {
  const match = /^v(\d+)\.\d+\.\d+$/u.exec(value);
  return match !== null && Number(match[1]) >= 22;
}

function hasExactKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertSafePath(
  target: string,
  kind: "directory" | "executable" | "file",
  uid: number | undefined,
): Promise<void> {
  let info;
  try {
    info = await fs.lstat(target);
  } catch {
    throw unsafeBundle();
  }
  if (info.isSymbolicLink() ||
      (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
      (uid !== undefined && info.uid !== uid) ||
      (info.mode & 0o022) !== 0) {
    throw unsafeBundle();
  }
  if (kind === "executable") {
    try {
      await fs.access(target, fsConstants.X_OK);
    } catch {
      throw unsafeBundle();
    }
  }
}

function standaloneRequired(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Codex setup requires the reviewed standalone Safe WhatsApp installation.",
    "standalone_install_required",
  );
}

function unsafeBundle(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    `${PACKAGE_NAME} could not verify its standalone installation. Reinstall the reviewed bundle.`,
    "unsafe_standalone_install",
  );
}
