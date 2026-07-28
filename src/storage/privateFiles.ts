// Agent context note: Provides atomic private JSON/file primitives for local state. Tests: test/core-config-storage.test.mjs. Preserve 0700 directories and 0600 files where supported; update this note after meaningful changes.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SafeWhatsAppError } from "../errors.js";

export async function ensurePrivateDir(dirPath: string): Promise<void> {
  const existing = await safeLstat(dirPath);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw unsafePath("Private directory", dirPath);
  }
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const created = await fs.lstat(dirPath);
  if (!created.isDirectory() || created.isSymbolicLink()) throw unsafePath("Private directory", dirPath);
  await chmodIfSupported(dirPath, 0o700);
}

export async function ensurePrivateFile(filePath: string): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  await assertPrivateRegularFileOrMissing(filePath);
  const handle = await fs.open(filePath, "a", 0o600);
  await handle.close();
  await chmodIfSupported(filePath, 0o600);
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    await assertPrivateRegularFileOrMissing(filePath);
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  await assertPrivateRegularFileOrMissing(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmodIfSupported(temporary, 0o600);
  await fs.rename(temporary, filePath);
  await chmodIfSupported(filePath, 0o600);
}

export async function chmodIfSupported(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function assertPrivateRegularFileOrMissing(filePath: string): Promise<void> {
  const existing = await safeLstat(filePath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw unsafePath("Private file", filePath);
  }
}

async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function unsafePath(kind: string, filePath: string): SafeWhatsAppError {
  return new SafeWhatsAppError(
    `${kind} must not be a symbolic link or special filesystem object: ${path.basename(filePath)}.`,
    "unsafe_state_path",
  );
}
