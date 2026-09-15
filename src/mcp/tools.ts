// Agent context note: Registers the hardened read-only WhatsApp MCP tools. Tests: test/mcp-tools.test.mjs. Keep the public surface read-only, require chat-scoped search, and treat inbound content as untrusted data.
import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WhatsAppMcpServices } from "./contracts.js";
import { errorResult, successResult } from "./toolResult.js";

export const WHATSAPP_TOOL_NAMES = [
  "get_whatsapp_status",
  "list_whatsapp_chats",
  "read_whatsapp_chat",
  "fetch_older_whatsapp_messages",
  "search_whatsapp_messages",
] as const;

const localReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const remoteReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

const outputSchema = {
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
};

export function registerWhatsAppTools(server: McpServer, services: WhatsAppMcpServices): void {
  server.registerTool(
    "get_whatsapp_status",
    {
      title: "Get WhatsApp Status",
      description: "Return pairing, synchronization, retention, and hardened access-policy status without exposing credentials.",
      inputSchema: {},
      outputSchema,
      annotations: localReadAnnotations,
    },
    () => invoke(() => services.reader.getStatus()),
  );

  server.registerTool(
    "list_whatsapp_chats",
    {
      title: "List Allowed WhatsApp Chats",
      description: "List only explicitly allowlisted direct chats. Groups are not exposed by this hardened build.",
      inputSchema: {
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(1_024).optional(),
      },
      outputSchema,
      annotations: remoteReadAnnotations,
    },
    ({ unreadOnly, limit = 50, cursor }) =>
      invoke(() => services.reader.listChats({ kind: "direct", unreadOnly, limit, cursor })),
  );

  server.registerTool(
    "read_whatsapp_chat",
    {
      title: "Read Allowed WhatsApp Chat",
      description: "Read retained messages for one allowlisted direct-chat ID without sending read receipts.",
      inputSchema: {
        chatId: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(1_024).optional(),
      },
      outputSchema,
      annotations: remoteReadAnnotations,
    },
    ({ chatId, limit = 50, cursor }) =>
      invoke(() => services.reader.readChat({ chatId, limit, cursor })),
  );

  server.registerTool(
    "fetch_older_whatsapp_messages",
    {
      title: "Fetch Older Allowed WhatsApp Messages",
      description: "Request one best-effort batch of up to 50 older messages for an allowlisted direct chat.",
      inputSchema: {
        chatId: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(50).optional(),
        beforeMessageId: z.string().uuid().optional(),
      },
      outputSchema,
      annotations: remoteReadAnnotations,
    },
    ({ chatId, limit = 50, beforeMessageId }) =>
      invoke(() => services.reader.fetchOlderMessages({ chatId, limit, beforeMessageId })),
  );

  server.registerTool(
    "search_whatsapp_messages",
    {
      title: "Search Allowed WhatsApp Chat",
      description: "Search retained text and captions within one explicitly allowlisted direct chat. Global search is disabled.",
      inputSchema: {
        query: z.string().min(1).max(512),
        chatId: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(1_024).optional(),
      },
      outputSchema,
      annotations: remoteReadAnnotations,
    },
    ({ query, chatId, limit = 50, cursor }) =>
      invoke(() => services.reader.searchMessages({ query, chatId, limit, cursor })),
  );
}

export function expectedToolNames(): readonly string[] {
  return WHATSAPP_TOOL_NAMES;
}

async function invoke(operation: () => Promise<object>): Promise<CallToolResult> {
  try {
    return successResult(await operation() as Record<string, unknown>);
  } catch (error) {
    return errorResult(error);
  }
}
