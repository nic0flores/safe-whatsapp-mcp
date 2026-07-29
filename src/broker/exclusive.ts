// Agent context note: Serializes direct CLI work against broker auto-launch and gives lifecycle commands an authenticated, drained state handoff. Tests: CLI, account lifecycle, and broker integration tests. Hold this around direct process-lock ownership and never bypass broker capability authentication; update this note after meaningful changes.
import type { StatePaths } from "../storage/paths.js";
import { SafeWhatsAppError } from "../errors.js";
import { ProcessLock } from "../storage/processLock.js";
import { stopBrokerForExclusiveState } from "./control.js";

const LAUNCH_LOCK_WAIT_MS = 15_000;
const LAUNCH_LOCK_RETRY_MS = 75;

export async function withBrokerLaunchLock<T>(
  paths: StatePaths,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = new ProcessLock(paths.brokerLaunchLockFile);
  await acquireLaunchLock(lock);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

export async function withBrokerStateTakeover<T>(
  paths: StatePaths,
  operation: () => Promise<T>,
): Promise<T> {
  return withBrokerLaunchLock(paths, async () => {
    await stopBrokerForExclusiveState(paths);
    return operation();
  });
}

async function acquireLaunchLock(lock: ProcessLock): Promise<void> {
  const deadline = Date.now() + LAUNCH_LOCK_WAIT_MS;
  for (;;) {
    try {
      await lock.acquire();
      return;
    } catch (error) {
      if (!(error instanceof SafeWhatsAppError) ||
          error.code !== "state_locked" ||
          Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_LOCK_RETRY_MS));
  }
}
