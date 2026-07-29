// Agent context note: Defines the bounded, mutually authenticated pre-MCP broker handshake, exact MCP policy binding, and separate lifecycle-shutdown purpose. Tests: test/broker-protocol.test.mjs and broker integration tests. Never transmit the broker secret, weaken ordinary proxy policy/version checks, or let handshake bytes enter MCP framing; update this note after meaningful changes.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type { SafeWhatsAppConfig } from "../config/config.js";
import { VERSION } from "../constants.js";
import { SafeWhatsAppError } from "../errors.js";

export const BROKER_PROTOCOL = 1;
export const BROKER_HOST = "127.0.0.1";
export const BROKER_HANDSHAKE_TIMEOUT_MS = 3_000;
export const BROKER_HANDSHAKE_MAX_BYTES = 4 * 1024;

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface BrokerPolicy {
  sendEnabled: boolean;
  mediaSendEnabled: boolean;
  configFingerprint: string;
}

export type BrokerPurpose = "mcp" | "shutdown";

export interface BrokerDescriptor extends BrokerPolicy {
  schema: 1;
  protocol: 1;
  packageVersion: string;
  instanceId: string;
  pid: number;
  port: number;
  secret: string;
  createdAt: string;
}

interface BrokerChallenge {
  type: "challenge";
  protocol: 1;
  packageVersion: string;
  instanceId: string;
  serverNonce: string;
}

interface ClientAuthentication extends BrokerPolicy {
  type: "authenticate";
  protocol: 1;
  packageVersion: string;
  instanceId: string;
  clientNonce: string;
  purpose?: "shutdown";
  proof: string;
}

interface BrokerReady {
  type: "ready";
  protocol: 1;
  packageVersion: string;
  instanceId: string;
  proof: string;
}

export function policyForConfig(config: SafeWhatsAppConfig): BrokerPolicy {
  return {
    sendEnabled: config.sendEnabled,
    mediaSendEnabled: config.mediaSendEnabled,
    configFingerprint: createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex"),
  };
}

export function policyFromDescriptor(descriptor: BrokerDescriptor): BrokerPolicy {
  return {
    sendEnabled: descriptor.sendEnabled,
    mediaSendEnabled: descriptor.mediaSendEnabled,
    configFingerprint: descriptor.configFingerprint,
  };
}

export function newBrokerSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function parseBrokerDescriptor(value: unknown): BrokerDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, [
    "configFingerprint",
    "createdAt",
    "instanceId",
    "mediaSendEnabled",
    "packageVersion",
    "pid",
    "port",
    "protocol",
    "schema",
    "secret",
    "sendEnabled",
  ])) throw invalidDescriptor();
  if (
    value.schema !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    typeof value.packageVersion !== "string" ||
    typeof value.instanceId !== "string" ||
    !isUuid(value.instanceId) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.secret !== "string" ||
    !BASE64URL_32.test(value.secret) ||
    typeof value.createdAt !== "string" ||
    !isIsoDate(value.createdAt) ||
    typeof value.sendEnabled !== "boolean" ||
    typeof value.mediaSendEnabled !== "boolean" ||
    typeof value.configFingerprint !== "string" ||
    !SHA256.test(value.configFingerprint)
  ) throw invalidDescriptor();
  if (value.mediaSendEnabled && !value.sendEnabled) throw invalidDescriptor();
  return value as unknown as BrokerDescriptor;
}

export async function authenticateBrokerClient(
  socket: Socket,
  descriptor: BrokerDescriptor,
  policy: BrokerPolicy,
  purpose: BrokerPurpose = "mcp",
): Promise<void> {
  const challenge = parseChallenge(await readHandshakeJson(socket));
  if (
    challenge.instanceId !== descriptor.instanceId ||
    challenge.protocol !== descriptor.protocol
  ) throw authenticationFailed();
  const packageVersion = purpose === "mcp" ? VERSION : descriptor.packageVersion;
  if (challenge.packageVersion !== packageVersion ||
      descriptor.packageVersion !== packageVersion) {
    throw new SafeWhatsAppError(
      "A different Safe WhatsApp version owns the local broker. Restart all Safe WhatsApp clients.",
      "broker_version_mismatch",
    );
  }
  assertPolicyMatches(descriptor, policy);
  const clientNonce = newNonce();
  const transcript = proofTranscript(challenge, clientNonce, policy, purpose);
  const authentication: ClientAuthentication = {
    type: "authenticate",
    protocol: BROKER_PROTOCOL,
    packageVersion,
    instanceId: descriptor.instanceId,
    clientNonce,
    ...(purpose === "shutdown" ? { purpose } : {}),
    ...policy,
    proof: proof(descriptor.secret, "client", transcript),
  };
  await writeHandshakeJson(socket, authentication);
  const ready = parseReady(await readHandshakeJson(socket));
  if (
    ready.instanceId !== descriptor.instanceId ||
    ready.protocol !== BROKER_PROTOCOL ||
    ready.packageVersion !== packageVersion ||
    !proofMatches(ready.proof, descriptor.secret, "server", transcript)
  ) throw authenticationFailed();
}

export async function authenticateBrokerSocket(
  socket: Socket,
  descriptor: BrokerDescriptor,
): Promise<BrokerPurpose> {
  const challenge: BrokerChallenge = {
    type: "challenge",
    protocol: BROKER_PROTOCOL,
    packageVersion: descriptor.packageVersion,
    instanceId: descriptor.instanceId,
    serverNonce: newNonce(),
  };
  await writeHandshakeJson(socket, challenge);
  const authentication = parseAuthentication(await readHandshakeJson(socket));
  const purpose = authentication.purpose ?? "mcp";
  const packageVersion = purpose === "mcp" ? VERSION : descriptor.packageVersion;
  const policy: BrokerPolicy = {
    sendEnabled: authentication.sendEnabled,
    mediaSendEnabled: authentication.mediaSendEnabled,
    configFingerprint: authentication.configFingerprint,
  };
  if (
    authentication.instanceId !== descriptor.instanceId ||
    authentication.protocol !== BROKER_PROTOCOL ||
    authentication.packageVersion !== packageVersion
  ) throw authenticationFailed();
  assertPolicyMatches(descriptor, policy);
  const transcript = proofTranscript(challenge, authentication.clientNonce, policy, purpose);
  if (!proofMatches(authentication.proof, descriptor.secret, "client", transcript)) {
    throw authenticationFailed();
  }
  const ready: BrokerReady = {
    type: "ready",
    protocol: BROKER_PROTOCOL,
    packageVersion,
    instanceId: descriptor.instanceId,
    proof: proof(descriptor.secret, "server", transcript),
  };
  await writeHandshakeJson(socket, ready);
  return purpose;
}

export async function readHandshakeJson(socket: Socket): Promise<unknown> {
  const line = await readLine(socket);
  try {
    return JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    throw authenticationFailed();
  }
}

export async function writeHandshakeJson(socket: Socket, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (bytes.byteLength > BROKER_HANDSHAKE_MAX_BYTES) throw authenticationFailed();
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

function readLine(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: unknown, line?: Buffer, rest?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.pause();
      if (rest && rest.byteLength > 0 && !socket.destroyed) socket.unshift(rest);
      if (error) reject(error);
      else resolve(line ?? Buffer.alloc(0));
    };
    const onError = () => finish(authenticationFailed());
    const onEnd = () => finish(authenticationFailed());
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const newline = bytes.indexOf(0x0a);
      const head = newline < 0 ? bytes : bytes.subarray(0, newline);
      if (buffered.byteLength + head.byteLength > BROKER_HANDSHAKE_MAX_BYTES) {
        finish(authenticationFailed());
        return;
      }
      buffered = Buffer.concat([buffered, head]);
      if (newline >= 0) finish(undefined, buffered, bytes.subarray(newline + 1));
    };
    const timer = setTimeout(
      () => finish(authenticationFailed()),
      BROKER_HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.resume();
  });
}

function parseChallenge(value: unknown): BrokerChallenge {
  if (!isRecord(value) || !hasExactKeys(value, [
    "instanceId",
    "packageVersion",
    "protocol",
    "serverNonce",
    "type",
  ]) || value.type !== "challenge" ||
      value.protocol !== BROKER_PROTOCOL ||
      typeof value.packageVersion !== "string" ||
      typeof value.instanceId !== "string" ||
      !isUuid(value.instanceId) ||
      typeof value.serverNonce !== "string" ||
      !BASE64URL_32.test(value.serverNonce)) {
    throw authenticationFailed();
  }
  return value as unknown as BrokerChallenge;
}

function parseAuthentication(value: unknown): ClientAuthentication {
  const baseKeys = [
    "clientNonce",
    "configFingerprint",
    "instanceId",
    "mediaSendEnabled",
    "packageVersion",
    "proof",
    "protocol",
    "sendEnabled",
    "type",
  ];
  if (!isRecord(value) ||
      !hasExactKeys(value, value.purpose === "shutdown"
        ? [...baseKeys, "purpose"]
        : baseKeys) ||
      value.type !== "authenticate" ||
      value.protocol !== BROKER_PROTOCOL ||
      typeof value.packageVersion !== "string" ||
      typeof value.instanceId !== "string" ||
      !isUuid(value.instanceId) ||
      typeof value.clientNonce !== "string" ||
      !BASE64URL_32.test(value.clientNonce) ||
      typeof value.sendEnabled !== "boolean" ||
      typeof value.mediaSendEnabled !== "boolean" ||
      typeof value.configFingerprint !== "string" ||
      !SHA256.test(value.configFingerprint) ||
      typeof value.proof !== "string" ||
      !BASE64URL_32.test(value.proof)) {
    throw authenticationFailed();
  }
  return value as unknown as ClientAuthentication;
}

function parseReady(value: unknown): BrokerReady {
  if (!isRecord(value) || !hasExactKeys(value, [
    "instanceId",
    "packageVersion",
    "proof",
    "protocol",
    "type",
  ]) || value.type !== "ready" ||
      value.protocol !== BROKER_PROTOCOL ||
      typeof value.packageVersion !== "string" ||
      typeof value.instanceId !== "string" ||
      !isUuid(value.instanceId) ||
      typeof value.proof !== "string" ||
      !BASE64URL_32.test(value.proof)) {
    throw authenticationFailed();
  }
  return value as unknown as BrokerReady;
}

function proofTranscript(
  challenge: BrokerChallenge,
  clientNonce: string,
  policy: BrokerPolicy,
  purpose: BrokerPurpose,
): string {
  const transcript: unknown[] = [
    BROKER_PROTOCOL,
    challenge.packageVersion,
    challenge.instanceId,
    challenge.serverNonce,
    clientNonce,
    policy.sendEnabled,
    policy.mediaSendEnabled,
    policy.configFingerprint,
  ];
  if (purpose === "shutdown") transcript.push(purpose);
  return JSON.stringify(transcript);
}

function proof(secret: string, role: "client" | "server", transcript: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("safe-whatsapp-broker-v1\0" + role + "\0" + transcript)
    .digest("base64url");
}

function proofMatches(
  candidate: string,
  secret: string,
  role: "client" | "server",
  transcript: string,
): boolean {
  if (!BASE64URL_32.test(candidate)) return false;
  const actual = Buffer.from(candidate, "base64url");
  const expected = Buffer.from(proof(secret, role, transcript), "base64url");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function assertPolicyMatches(actual: BrokerPolicy, expected: BrokerPolicy): void {
  if (
    actual.sendEnabled !== expected.sendEnabled ||
    actual.mediaSendEnabled !== expected.mediaSendEnabled ||
    actual.configFingerprint !== expected.configFingerprint
  ) {
    throw new SafeWhatsAppError(
      "Safe WhatsApp configuration differs from the running local broker. Restart all Safe WhatsApp clients.",
      "broker_configuration_mismatch",
    );
  }
}

function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function invalidDescriptor(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The local broker descriptor is invalid.",
    "broker_descriptor_invalid",
  );
}

function authenticationFailed(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The local broker authentication failed.",
    "broker_authentication_failed",
  );
}
