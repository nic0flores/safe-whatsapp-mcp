// Agent context note: Exercises the broker's real loopback mutual-authentication boundary. Keep failures fail-closed before the MCP session callback and update this note when the handshake changes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { VERSION } from "../dist/constants.js";
import {
  authenticateBrokerClient,
  authenticateBrokerSocket,
  BROKER_HANDSHAKE_MAX_BYTES,
  BROKER_HOST,
  BROKER_PROTOCOL,
  newBrokerSecret,
  policyForConfig,
} from "../dist/broker/protocol.js";
import { runtimeConfig } from "./core-helpers.mjs";

const basePolicy = policyForConfig(runtimeConfig);

test("broker and proxy mutually authenticate over a loopback socket", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = brokerDescriptor();

  const [purpose] = await Promise.all([
    authenticateBrokerSocket(pair.accepted, descriptor),
    authenticateBrokerClient(pair.client, descriptor, basePolicy),
  ]);
  assert.equal(purpose, "mcp");

  const received = once(pair.accepted, "data");
  pair.accepted.resume();
  pair.client.write('{"jsonrpc":"2.0","method":"initialize"}\n');
  assert.equal((await received)[0].toString("utf8"), '{"jsonrpc":"2.0","method":"initialize"}\n');
});

test("an authenticated shutdown purpose is HMAC-bound and version-tolerant", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = { ...brokerDescriptor(), packageVersion: "0.0.9" };

  const [purpose] = await Promise.all([
    authenticateBrokerSocket(pair.accepted, descriptor),
    authenticateBrokerClient(pair.client, descriptor, basePolicy, "shutdown"),
  ]);

  assert.equal(purpose, "shutdown");
});

test("a forged shutdown capability is rejected", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = brokerDescriptor();
  const forged = { ...descriptor, secret: newBrokerSecret() };

  const serverResultPromise = outcome(authenticateBrokerSocket(pair.accepted, descriptor));
  const clientResultPromise = outcome(
    authenticateBrokerClient(pair.client, forged, basePolicy, "shutdown"),
  );
  const serverResult = await serverResultPromise;
  pair.accepted.destroy();
  const clientResult = await clientResultPromise;

  assertErrorCode(serverResult, "broker_authentication_failed");
  assertErrorCode(clientResult, "broker_authentication_failed");
});

test("a wrong broker secret is rejected before an MCP session can open", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = brokerDescriptor();
  const forged = { ...descriptor, secret: newBrokerSecret() };
  let openedMcp = false;

  const serverResultPromise = outcome(
    authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
  );
  const clientResultPromise = outcome(
    authenticateBrokerClient(pair.client, forged, basePolicy),
  );
  const serverResult = await serverResultPromise;
  pair.accepted.destroy();
  const clientResult = await clientResultPromise;

  assertErrorCode(serverResult, "broker_authentication_failed");
  assertErrorCode(clientResult, "broker_authentication_failed");
  assert.equal(openedMcp, false);
});

test("the proxy rejects a descriptor that differs from its exact configuration", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = brokerDescriptor();
  const differentPolicy = policyForConfig({ ...runtimeConfig, sendEnabled: true });
  let openedMcp = false;

  const serverResultPromise = outcome(
    authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
  );
  const clientResult = await outcome(
    authenticateBrokerClient(pair.client, descriptor, differentPolicy),
  );
  pair.client.destroy();
  await serverResultPromise;

  assertErrorCode(clientResult, "broker_configuration_mismatch");
  assert.equal(openedMcp, false);
});

test("the proxy rejects a media-policy mismatch before MCP can open", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = {
    ...brokerDescriptor(),
    sendEnabled: true,
    mediaSendEnabled: false,
  };
  const differentPolicy = {
    sendEnabled: true,
    mediaSendEnabled: true,
    configFingerprint: descriptor.configFingerprint,
  };
  let openedMcp = false;

  const serverResultPromise = outcome(
    authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
  );
  const clientResult = await outcome(
    authenticateBrokerClient(pair.client, descriptor, differentPolicy),
  );
  pair.client.destroy();
  await serverResultPromise;

  assertErrorCode(clientResult, "broker_configuration_mismatch");
  assert.equal(openedMcp, false);
});

test("the broker rejects a proxy whose advertised configuration differs", async (t) => {
  const pair = await openSocketPair();
  t.after(() => pair.close());
  const descriptor = brokerDescriptor();
  const differentPolicy = policyForConfig({ ...runtimeConfig, sendEnabled: true });
  const forgedDescriptor = { ...descriptor, ...differentPolicy };
  let openedMcp = false;

  const serverResultPromise = outcome(
    authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
  );
  const clientResultPromise = outcome(
    authenticateBrokerClient(pair.client, forgedDescriptor, differentPolicy),
  );
  const serverResult = await serverResultPromise;
  pair.accepted.destroy();
  await clientResultPromise;

  assertErrorCode(serverResult, "broker_configuration_mismatch");
  assert.equal(openedMcp, false);
});

test("malformed and oversized handshakes are rejected before MCP", async (t) => {
  await t.test("malformed JSON", async (subtest) => {
    const pair = await openSocketPair();
    subtest.after(() => pair.close());
    const descriptor = brokerDescriptor();
    let openedMcp = false;
    const resultPromise = outcome(
      authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
    );

    await readRawLine(pair.client);
    pair.client.write("{malformed\n");
    const result = await resultPromise;

    assertErrorCode(result, "broker_authentication_failed");
    assert.equal(openedMcp, false);
  });

  await t.test("oversized line", async (subtest) => {
    const pair = await openSocketPair();
    subtest.after(() => pair.close());
    const descriptor = brokerDescriptor();
    let openedMcp = false;
    const resultPromise = outcome(
      authenticateBrokerSocket(pair.accepted, descriptor).then(() => { openedMcp = true; }),
    );

    await readRawLine(pair.client);
    pair.client.write(Buffer.alloc(BROKER_HANDSHAKE_MAX_BYTES + 1, 0x78));
    const result = await resultPromise;

    assertErrorCode(result, "broker_authentication_failed");
    assert.equal(openedMcp, false);
  });
});

function brokerDescriptor() {
  return {
    schema: 1,
    protocol: BROKER_PROTOCOL,
    packageVersion: VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    port: 1,
    secret: newBrokerSecret(),
    createdAt: new Date().toISOString(),
    ...basePolicy,
  };
}

async function openSocketPair() {
  const listener = createServer({ pauseOnConnect: true });
  listener.listen({ host: BROKER_HOST, port: 0 });
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  const acceptedPromise = once(listener, "connection");
  const client = createConnection({ host: BROKER_HOST, port: address.port });
  client.pause();
  await once(client, "connect");
  const [accepted] = await acceptedPromise;
  client.on("error", () => undefined);
  accepted.on("error", () => undefined);
  return {
    listener,
    client,
    accepted,
    async close() {
      client.destroy();
      accepted.destroy();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

function readRawLine(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      const newline = chunk.indexOf(0x0a);
      const head = newline < 0 ? chunk : chunk.subarray(0, newline);
      buffered = Buffer.concat([buffered, head]);
      if (newline < 0) return;
      cleanup();
      const rest = chunk.subarray(newline + 1);
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffered);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.resume();
  });
}

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

function assertErrorCode(result, expected) {
  assert("error" in result);
  assert.equal(result.error.code, expected);
}
