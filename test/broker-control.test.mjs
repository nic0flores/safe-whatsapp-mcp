import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withBrokerLaunchLock,
  withBrokerStateTakeover,
} from "../dist/broker/exclusive.js";
import { writeBrokerDescriptor } from "../dist/broker/descriptor.js";
import {
  BROKER_PROTOCOL,
  newBrokerSecret,
  policyForConfig,
} from "../dist/broker/protocol.js";
import { VERSION } from "../dist/constants.js";
import { ProcessLock } from "../dist/storage/processLock.js";
import { StatePaths } from "../dist/storage/paths.js";
import { runtimeConfig } from "./core-helpers.mjs";

test("exclusive handoff recovers a crashed broker generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-stale-broker-"));
  const paths = new StatePaths(path.join(root, "state"));
  const deadPid = 2_000_000_000;
  try {
    await fs.mkdir(paths.rootDir, { recursive: true, mode: 0o700 });
    await writeBrokerDescriptor(paths, {
      schema: 1,
      protocol: BROKER_PROTOCOL,
      packageVersion: VERSION,
      instanceId: randomUUID(),
      pid: deadPid,
      port: 1,
      secret: newBrokerSecret(),
      createdAt: new Date().toISOString(),
      ...policyForConfig(runtimeConfig),
    });
    await fs.writeFile(paths.lockFile, JSON.stringify({
      pid: deadPid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });

    await withBrokerStateTakeover(paths, async () => {
      const direct = new ProcessLock(paths.lockFile);
      await direct.acquire();
      await direct.release();
    });

    await assert.rejects(fs.access(paths.brokerFile), (error) => error.code === "ENOENT");
    await assert.rejects(fs.access(paths.lockFile), (error) => error.code === "ENOENT");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exclusive work waits for an in-progress broker launch election", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-launch-wait-"));
  const paths = new StatePaths(path.join(root, "state"));
  const competing = new ProcessLock(paths.brokerLaunchLockFile);
  try {
    await competing.acquire();
    let entered = false;
    const waiting = withBrokerLaunchLock(paths, async () => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(entered, false);
    await competing.release();
    await waiting;
    assert.equal(entered, true);
  } finally {
    await competing.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});
