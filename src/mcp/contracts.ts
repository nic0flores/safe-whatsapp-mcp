// Agent context note: Defines the general-purpose read/history/media capabilities consumed by the MCP registry. Tests: test/mcp-tools.test.mjs. Keep the MCP layer independent from Baileys and concrete persistence; domain interpretation belongs to the calling agent.
import type { InboundMediaReader } from "../media/inboundMedia.js";
import type { WhatsAppSendOperations } from "../replies/sendService.js";
import type { WhatsAppReviewOperations } from "../review/types.js";

export type WhatsAppMediaKind = "image" | "audio" | "video" | "document" | "sticker";
export type WhatsAppMessageOrder = "asc" | "desc";

export interface WhatsAppReadOperations {
  getStatus(): Promise<Record<string, unknown>>;
  listChats(input: {
    kind?: "all" | "direct" | "group";
    unreadOnly?: boolean;
    query?: string;
    activeAfter?: string;
    activeBefore?: string;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  listMessages(input: {
    chatId?: string;
    after?: string;
    before?: string;
    fromMe?: boolean;
    hasAttachment?: boolean;
    mediaKind?: WhatsAppMediaKind;
    order?: WhatsAppMessageOrder;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  readChat(input: {
    chatId: string;
    after?: string;
    before?: string;
    order?: WhatsAppMessageOrder;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
  fetchOlderMessages(input: {
    chatId: string;
    limit: number;
    beforeMessageId?: string;
  }): Promise<Record<string, unknown>>;
  resyncMessages(): Promise<Record<string, unknown>>;
  searchMessages(input: {
    query: string;
    chatId?: string;
    after?: string;
    before?: string;
    fromMe?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Record<string, unknown>>;
}

export interface WhatsAppMcpServices {
  reader: WhatsAppReadOperations;
  media: InboundMediaReader;
  sends: WhatsAppSendOperations;
  reviews: WhatsAppReviewOperations;
}
