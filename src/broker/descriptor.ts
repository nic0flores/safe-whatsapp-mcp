// Agent context note: Publishes and reads the private broker capability descriptor with bounded no-follow filesystem checks. Tests: test/broker-descriptor.test.mjs and broker integration tests. Keep it atomic 0600, reject special files and permissive ownership, and only remove the exact broker generation.
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { isNodeError, writePrivateJson } from "../storage/privateFiles.js";
import type { StatePaths } from "../storage/paths.js";
import { SafeWhatsAppError } from "../errors.js";
import {
  parseBrokerDescriptor,
  type BrokerDescriptor,
} from "./protocol.js";

const MAX_DESCRIPTOR_BYTES = 4 * 1024;

export async function readBrokerDescriptor(
  paths: StatePaths,
): Promise<BrokerDescriptor | undefined> {
  let inspected: Stats;
  try {
    inspected = await fs.lstat(paths.brokerFile);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  assertSafeDescriptorFile(inspected);

  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await fs.open(paths.brokerFile, flags);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw invalidDescriptor();
  }
  try {
    const opened = await handle.stat();
    assertSafeDescriptorFile(opened);
    if (!sameFile(inspected, opened) || opened.size > MAX_DESCRIPTOR_BYTES) {
      throw invalidDescriptor();
    }
    const bytes = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    let offset = 0;
    for (;;) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      if (offset > MAX_DESCRIPTOR_BYTES || offset === bytes.byteLength) {
        throw invalidDescriptor();
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
    } catch {
      throw invalidDescriptor();
    }
    return parseBrokerDescriptor(value);
  } finally {
    await handle.close();
  }
}

export async function writeBrokerDescriptor(
  paths: StatePaths,
  descriptor: BrokerDescriptor,
): Promise<void> {
  parseBrokerDescriptor(descriptor);
  await writePrivateJson(paths.brokerFile, descriptor);
  const written = await readBrokerDescriptor(paths);
  if (!written ||
      written.instanceId !== descriptor.instanceId ||
      written.secret !== descriptor.secret) {
    throw invalidDescriptor();
  }
}

export async function removeBrokerDescriptor(
  paths: StatePaths,
  descriptor: BrokerDescriptor,
): Promise<void> {
  let current: BrokerDescriptor | undefined;
  try {
    current = await readBrokerDescriptor(paths);
  } catch {
    return;
  }
  if (
    current?.instanceId !== descriptor.instanceId ||
    current.secret !== descriptor.secret
  ) return;
  await fs.unlink(paths.brokerFile).catch((error) => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
}

function assertSafeDescriptorFile(info: Stats): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
    (uid !== undefined && info.uid !== uid)
  ) throw invalidDescriptor();
}

function sameFile(first: Stats, second: Stats): boolean {
  if (process.platform === "win32") {
    return first.size === second.size && first.birthtimeMs === second.birthtimeMs;
  }
  return first.dev === second.dev && first.ino === second.ino;
}

function invalidDescriptor(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The local broker descriptor is invalid.",
    "broker_descriptor_invalid",
  );
}
