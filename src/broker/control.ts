// Agent context note: Authenticates an exclusive CLI handoff request to the broker and waits for its exact state-lock generation to drain. Tests: broker protocol and integration tests. Never signal descriptor PIDs, bypass capability authentication, or remove a live broker generation; update this note after meaningful changes.
import type { Socket } from "node:net";
import { SafeWhatsAppError } from "../errors.js";
import {
  isProcessRunning,
  readProcessLockPid,
} from "../storage/processLock.js";
import type { StatePaths } from "../storage/paths.js";
import {
  readBrokerDescriptor,
  removeBrokerDescriptor,
} from "./descriptor.js";
import { connectToBrokerDescriptor } from "./proxy.js";
import {
  policyFromDescriptor,
  type BrokerDescriptor,
} from "./protocol.js";

const DEFAULT_HANDOFF_TIMEOUT_MS = 180_000;
const CONTROL_CLOSE_TIMEOUT_MS = 1_000;
const STARTUP_SETTLE_TIMEOUT_MS = 12_000;

export interface BrokerHandoffOptions {
  timeoutMs?: number;
}

export async function stopBrokerForExclusiveState(
  paths: StatePaths,
  options: BrokerHandoffOptions = {},
): Promise<boolean> {
  const descriptor = await findBrokerDescriptor(paths);
  if (!descriptor) return false;
  if (!await brokerOwnsState(paths, descriptor)) return false;

  let socket: Socket;
  try {
    socket = await connectToBrokerDescriptor(
      descriptor,
      policyFromDescriptor(descriptor),
      "shutdown",
    );
  } catch {
    if (!await sameLiveBrokerOwnsState(paths, descriptor)) {
      await waitForBrokerRelease(
        paths,
        descriptor,
        options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
      );
      return true;
    }
    throw handoffFailed();
  }

  await closeControlSocket(socket);
  await waitForBrokerRelease(
    paths,
    descriptor,
    options.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
  );
  return true;
}

async function findBrokerDescriptor(
  paths: StatePaths,
): Promise<BrokerDescriptor | undefined> {
  const present = await readBrokerDescriptor(paths);
  if (present) return present;
  let lockPid = await readProcessLockPid(paths.lockFile);
  if (lockPid === undefined) return undefined;
  const deadline = Date.now() + STARTUP_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const descriptor = await readBrokerDescriptor(paths);
    if (descriptor) return descriptor;
    if (!isProcessRunning(lockPid)) return undefined;
    await pause(50);
    const currentLockPid = await readProcessLockPid(paths.lockFile);
    if (currentLockPid === undefined) return undefined;
    lockPid = currentLockPid;
  }
  throw new SafeWhatsAppError(
    "Safe WhatsApp state is still starting without a ready broker. Retry after the current process exits.",
    "broker_handoff_timeout",
  );
}

async function brokerOwnsState(
  paths: StatePaths,
  descriptor: BrokerDescriptor,
): Promise<boolean> {
  const lockPid = await readProcessLockPid(paths.lockFile);
  if (lockPid === descriptor.pid) return true;
  const current = await readBrokerDescriptor(paths);
  const sameGeneration = current?.instanceId === descriptor.instanceId &&
    current.secret === descriptor.secret;
  if (!sameGeneration && lockPid === undefined) return false;
  if (isProcessRunning(descriptor.pid)) throw handoffFailed();
  await removeBrokerDescriptor(paths, descriptor);
  return false;
}

async function sameLiveBrokerOwnsState(
  paths: StatePaths,
  descriptor: BrokerDescriptor,
): Promise<boolean> {
  const current = await readBrokerDescriptor(paths);
  return current?.instanceId === descriptor.instanceId &&
    current.secret === descriptor.secret &&
    await readProcessLockPid(paths.lockFile) === descriptor.pid &&
    isProcessRunning(descriptor.pid);
}

async function closeControlSocket(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.end();
  await Promise.race([closed, pause(CONTROL_CLOSE_TIMEOUT_MS)]);
  socket.destroy();
}

async function waitForBrokerRelease(
  paths: StatePaths,
  descriptor: BrokerDescriptor,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readBrokerDescriptor(paths);
    const lockPid = await readProcessLockPid(paths.lockFile);
    const sameGeneration = current?.instanceId === descriptor.instanceId &&
      current.secret === descriptor.secret;
    if (!sameGeneration && lockPid !== descriptor.pid) return;
    if (!isProcessRunning(descriptor.pid)) {
      await removeBrokerDescriptor(paths, descriptor);
      return;
    }
    await pause(50);
  }
  throw new SafeWhatsAppError(
    "The local Safe WhatsApp broker did not finish its active work in time. Retry after current agent operations finish.",
    "broker_handoff_timeout",
  );
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function handoffFailed(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The running Safe WhatsApp broker could not hand off exclusive state access. Restart Safe WhatsApp Codex clients, then retry.",
    "broker_handoff_failed",
  );
}
