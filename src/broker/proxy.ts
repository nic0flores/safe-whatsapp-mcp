// Agent context note: Keeps each Codex STDIO process lightweight by authenticating to, parent-safely auto-starting, and byte-proxying one local broker. Tests: broker integration and package smoke tests. Spawn only the bundled current runtime, abandon pre-ready children when their launcher dies, never retry MCP operations, and keep stdout exclusively MCP-framed; update this note after meaningful changes.
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { ConfigLoader, type SafeWhatsAppConfig } from "../config/config.js";
import { SafeWhatsAppError } from "../errors.js";
import { ProcessLock } from "../storage/processLock.js";
import { StatePaths } from "../storage/paths.js";
import { readBrokerDescriptor } from "./descriptor.js";
import {
  authenticateBrokerClient,
  BROKER_HOST,
  policyForConfig,
  type BrokerDescriptor,
  type BrokerPolicy,
  type BrokerPurpose,
} from "./protocol.js";

const BROKER_START_TIMEOUT_MS = 12_000;
const BROKER_CONNECT_TIMEOUT_MS = 1_000;
const BROKER_RETRY_MS = 75;
const BROKER_RELAUNCH_MS = 2_000;

class BrokerUnavailableError extends Error {}

export interface BrokerConnectionOptions {
  paths?: StatePaths;
  config?: SafeWhatsAppConfig;
  startupTimeoutMs?: number;
}

export async function serveThroughBroker(
  options: BrokerConnectionOptions = {},
): Promise<void> {
  const socket = await connectToLocalBroker(options);
  await proxyStdio(socket);
}

export async function connectToLocalBroker(
  options: BrokerConnectionOptions = {},
): Promise<Socket> {
  const paths = options.paths ?? new StatePaths();
  const config = options.config ?? await new ConfigLoader(paths).load();
  const policy = policyForConfig(config);
  const deadline = Date.now() + (options.startupTimeoutMs ?? BROKER_START_TIMEOUT_MS);

  try {
    return await connectExisting(paths, policy);
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }

  for (;;) {
    if (Date.now() >= deadline) throw brokerUnavailable();
    const launchLock = new ProcessLock(paths.brokerLaunchLockFile);
    try {
      await launchLock.acquire();
    } catch (error) {
      if (!(error instanceof SafeWhatsAppError) || error.code !== "state_locked") throw error;
      await pause(BROKER_RETRY_MS);
      try {
        return await connectExisting(paths, policy);
      } catch (connectError) {
        if (!isUnavailable(connectError)) throw connectError;
        continue;
      }
    }

    try {
      try {
        return await connectExisting(paths, policy);
      } catch (error) {
        if (!isUnavailable(error)) throw error;
      }
      let lastLaunch = 0;
      while (Date.now() < deadline) {
        if (Date.now() - lastLaunch >= BROKER_RELAUNCH_MS) {
          launchBroker();
          lastLaunch = Date.now();
        }
        await pause(BROKER_RETRY_MS);
        try {
          return await connectExisting(paths, policy);
        } catch (error) {
          if (!isUnavailable(error)) throw error;
        }
      }
      throw brokerUnavailable();
    } finally {
      await launchLock.release();
    }
  }
}

async function connectExisting(paths: StatePaths, policy: BrokerPolicy): Promise<Socket> {
  let descriptor: BrokerDescriptor | undefined;
  try {
    descriptor = await readBrokerDescriptor(paths);
  } catch {
    throw new BrokerUnavailableError();
  }
  if (!descriptor) throw new BrokerUnavailableError();
  return connectToBrokerDescriptor(descriptor, policy);
}

export async function connectToBrokerDescriptor(
  descriptor: BrokerDescriptor,
  policy: BrokerPolicy,
  purpose: BrokerPurpose = "mcp",
): Promise<Socket> {
  const socket = await connectSocket(descriptor.port);
  try {
    await authenticateBrokerClient(socket, descriptor, policy, purpose);
    return socket;
  } catch (error) {
    socket.destroy();
    if (
      error instanceof SafeWhatsAppError &&
      (error.code === "broker_configuration_mismatch" ||
       error.code === "broker_version_mismatch")
    ) throw error;
    throw new BrokerUnavailableError();
  }
}

function connectSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: BROKER_HOST, port });
    socket.pause();
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new BrokerUnavailableError());
    }, BROKER_CONNECT_TIMEOUT_MS);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      socket.setNoDelay(true);
      socket.on("error", () => undefined);
      resolve(socket);
    };
    const onError = () => {
      cleanup();
      socket.destroy();
      reject(new BrokerUnavailableError());
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function launchBroker(): void {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "broker", "--parented"], {
    detached: true,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.once("error", () => undefined);
  child.channel?.unref();
  child.unref();
}

async function proxyStdio(socket: Socket): Promise<void> {
  let closing = false;
  let socketFailed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const closeGracefully = () => {
    if (closing) return;
    closing = true;
    socket.end();
  };
  const closeImmediately = () => {
    if (closing) return;
    closing = true;
    socket.destroy();
  };
  const onSocketError = () => {
    socketFailed = true;
  };
  const onSocketClose = () => resolveClosed();

  socket.once("error", onSocketError);
  socket.once("close", onSocketClose);
  process.once("SIGINT", closeImmediately);
  process.once("SIGTERM", closeImmediately);
  process.stdin.once("end", closeGracefully);
  process.stdin.once("close", closeGracefully);
  process.stdin.once("error", closeImmediately);
  if (socket.destroyed) {
    resolveClosed();
  } else {
    socket.pipe(process.stdout, { end: false });
    process.stdin.pipe(socket);
  }
  try {
    await closed;
    if (!closing || socketFailed) {
      throw new SafeWhatsAppError(
        "The local Safe WhatsApp broker connection closed.",
        "broker_connection_closed",
      );
    }
  } finally {
    process.off("SIGINT", closeImmediately);
    process.off("SIGTERM", closeImmediately);
    process.stdin.off("end", closeGracefully);
    process.stdin.off("close", closeGracefully);
    process.stdin.off("error", closeImmediately);
    process.stdin.unpipe(socket);
    socket.unpipe(process.stdout);
    socket.destroy();
  }
}

function isUnavailable(error: unknown): error is BrokerUnavailableError {
  return error instanceof BrokerUnavailableError;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function brokerUnavailable(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "The local broker could not start. Close older Safe WhatsApp or Codex processes, then retry.",
    "broker_unavailable",
  );
}
