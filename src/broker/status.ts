// Agent context note: Reads CLI status through the shared broker so inspection never competes for SQLite or disconnects attached agents. Tests: CLI and broker integration tests. Live status may trigger the same bounded on-demand sync as an MCP read, and all returned errors must stay behind the public SafeWhatsApp boundary; update this note after meaningful changes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SafeWhatsAppApplication } from "../application.js";
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
import { withBrokerLaunchLock } from "./exclusive.js";
import { connectToBrokerDescriptor } from "./proxy.js";
import {
  policyFromDescriptor,
  type BrokerDescriptor,
} from "./protocol.js";

const STATUS_BUFFER_BYTES = 2 * 1024 * 1024;

export async function getCliStatus(
  paths: StatePaths,
  live: boolean,
): Promise<Record<string, unknown>> {
  return withBrokerLaunchLock(paths, async () => {
    const descriptor = await readBrokerDescriptor(paths);
    if (descriptor) {
      try {
        return await getStatusThroughBroker(descriptor, live);
      } catch {
        if (await sameLiveBrokerOwnsState(paths, descriptor)) throw statusFailed();
        await removeBrokerDescriptor(paths, descriptor);
      }
    }
    return getDirectStatus(paths, live);
  });
}

async function getStatusThroughBroker(
  descriptor: BrokerDescriptor,
  live: boolean,
): Promise<Record<string, unknown>> {
  const socket = await connectToBrokerDescriptor(
    descriptor,
    policyFromDescriptor(descriptor),
  );
  const transport = new StdioServerTransport(socket, socket, {
    maxBufferSize: STATUS_BUFFER_BYTES,
  });
  const client = new Client({ name: "safe-whatsapp-cli-status", version: "0.0.0" });
  try {
    socket.resume();
    await client.connect(transport);
    let status = requireToolData(await client.callTool({
      name: "get_whatsapp_status",
      arguments: {},
    }));
    if (live && status.paired === true) {
      requireToolData(await client.callTool({
        name: "list_whatsapp_chats",
        arguments: { kind: "all", limit: 1 },
      }));
      status = requireToolData(await client.callTool({
        name: "get_whatsapp_status",
        arguments: {},
      }));
    }
    return status;
  } finally {
    await client.close().catch(() => undefined);
    socket.end();
    socket.destroy();
  }
}

async function getDirectStatus(
  paths: StatePaths,
  live: boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let application: SafeWhatsAppApplication;
  for (;;) {
    try {
      application = await SafeWhatsAppApplication.open({ paths });
      break;
    } catch (error) {
      if (!(error instanceof SafeWhatsAppError) ||
          error.code !== "state_locked" ||
          Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    if (live && application.core.client.status().paired) {
      await application.core.client.connect();
    }
    return await application.services.reader.getStatus();
  } finally {
    await application.close();
  }
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

function requireToolData(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.structuredContent)) throw statusFailed();
  const structured = result.structuredContent;
  if (structured.ok === true && isRecord(structured.data)) return structured.data;
  if (isRecord(structured.error) &&
      typeof structured.error.code === "string" &&
      typeof structured.error.message === "string") {
    throw new SafeWhatsAppError(structured.error.message, structured.error.code);
  }
  throw statusFailed();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFailed(): SafeWhatsAppError {
  return new SafeWhatsAppError(
    "Safe WhatsApp status could not be read from the local broker.",
    "broker_status_failed",
  );
}
