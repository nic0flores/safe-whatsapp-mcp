// Agent context note: Defines the narrow read/history/media/send capabilities consumed by the MCP registry. Tests: test/mcp-tools.test.mjs. Keep the MCP layer independent from Baileys and concrete persistence; update this note after meaningful behavior changes.
import type { InboundMediaReader } from "../media/inboundMedia.js";
import type { WhatsAppSendOperations } from "../replies/sendService.js";

export interface WhatsAppReadOperations {
  getStatus(): Promise<Record<string, unknown>>;
  listChats(input: {
    kind?: "all" | "direct" | "group";
    unreadOnly?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  readChat(input: {
    chatId: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  fetchOlderMessages(input: {
    chatId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<Record<string, unknown>>;
  searchMessages(input: {
    query: string;
    chatId?: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
}

export interface WhatsAppMcpServices {
  reader: WhatsAppReadOperations;
  media: InboundMediaReader;
  sends: WhatsAppSendOperations;
}
