// Agent context note: Verifies that the broker capability descriptor remains private, bounded, regular, and generation-safe. Update this note whenever descriptor storage rules change.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../dist/constants.js";
import {
  readBrokerDescriptor,
  removeBrokerDescriptor,
  writeBrokerDescriptor,
} from "../dist/broker/descriptor.js";
import {
  BROKER_PROTOCOL,
  newBrokerSecret,
  policyForConfig,
} from "../dist/broker/protocol.js";
import { StatePaths } from "../dist/storage/paths.js";
import { runtimeConfig } from "./core-helpers.mjs";

test("broker descriptor round-trips as a private 0600 file", async (t) => {
  const fixture = await descriptorFixture(t);
  const descriptor = validDescriptor();

  await writeBrokerDescriptor(fixture.paths, descriptor);

  assert.deepEqual(await readBrokerDescriptor(fixture.paths), descriptor);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(fixture.paths.brokerFile)).mode & 0o777, 0o600);
  }

  await removeBrokerDescriptor(fixture.paths, {
    ...descriptor,
    instanceId: randomUUID(),
  });
  assert.deepEqual(await readBrokerDescriptor(fixture.paths), descriptor);
  await removeBrokerDescriptor(fixture.paths, descriptor);
  assert.equal(await readBrokerDescriptor(fixture.paths), undefined);
});

test("broker descriptor rejects a symbolic link", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await descriptorFixture(t);
  const outside = path.join(fixture.root, "outside.json");
  await fs.writeFile(outside, JSON.stringify(validDescriptor()), { mode: 0o600 });
  await fs.symlink(outside, fixture.paths.brokerFile);

  await assert.rejects(
    readBrokerDescriptor(fixture.paths),
    (error) => error.code === "broker_descriptor_invalid",
  );
});

test("broker descriptor rejects special filesystem objects", async (t) => {
  const fixture = await descriptorFixture(t);
  await fs.mkdir(fixture.paths.brokerFile, { mode: 0o700 });

  await assert.rejects(
    readBrokerDescriptor(fixture.paths),
    (error) => error.code === "broker_descriptor_invalid",
  );
});

test("broker descriptor rejects oversized content", async (t) => {
  const fixture = await descriptorFixture(t);
  await fs.writeFile(fixture.paths.brokerFile, Buffer.alloc(4 * 1024 + 1, 0x78), {
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(fixture.paths.brokerFile, 0o600);

  await assert.rejects(
    readBrokerDescriptor(fixture.paths),
    (error) => error.code === "broker_descriptor_invalid",
  );
});

test("broker descriptor rejects group- or world-readable permissions", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await descriptorFixture(t);
  await fs.writeFile(fixture.paths.brokerFile, JSON.stringify(validDescriptor()), {
    mode: 0o600,
  });
  await fs.chmod(fixture.paths.brokerFile, 0o644);

  await assert.rejects(
    readBrokerDescriptor(fixture.paths),
    (error) => error.code === "broker_descriptor_invalid",
  );
});

function validDescriptor() {
  return {
    schema: 1,
    protocol: BROKER_PROTOCOL,
    packageVersion: VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    port: 32_000,
    secret: newBrokerSecret(),
    createdAt: new Date().toISOString(),
    ...policyForConfig(runtimeConfig),
  };
}

async function descriptorFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safe-wa-broker-descriptor-"));
  const paths = new StatePaths(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, paths };
}
