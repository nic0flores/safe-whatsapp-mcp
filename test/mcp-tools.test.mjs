import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWhatsAppMcpServer, MCP_SERVER_INSTRUCTIONS } from "../dist/mcp/server.js";
import { expectedToolNames } from "../dist/mcp/tools.js";

test("MCP exposes exactly thirteen schema-backed tools with the intended risk annotations", async () => {
  const { client, close } = await connectedClient(fakeServices());
  const response = await client.listTools();
  const tools = new Map(response.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual([...tools.keys()].sort(), [...expectedToolNames()].sort());
  assert.equal(tools.size, 13);
  for (const tool of tools.values()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
  }
  assert.deepEqual(tools.get("get_whatsapp_status").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(tools.get("prepare_whatsapp_text_send").annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(tools.get("open_whatsapp_send_review").annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.equal(tools.get("read_whatsapp_chat").annotations.openWorldHint, true);
  assert.deepEqual(tools.get("fetch_older_whatsapp_messages").annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(tools.get("resync_whatsapp_messages").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  assert.equal(tools.get("get_whatsapp_media").annotations.openWorldHint, true);
  assert.equal(tools.get("list_whatsapp_sends").annotations.openWorldHint, false);
  assert.deepEqual(tools.get("send_prepared_whatsapp_message").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(tools.get("discard_prepared_whatsapp_message").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
  assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
  assert.match(client.getInstructions(), /untrusted data/u);
  assert.match(client.getInstructions(), /senderE164/u);
  assert.match(client.getInstructions(), /exact approvalPreview/u);
  assert.match(client.getInstructions(), /explicit user confirmation/u);
  assert.match(client.getInstructions(), /pendingId, digest, and approvalPreview unchanged/u);
  assert.ok(client.getInstructions().length <= 512);
  await close();
});

test("tools return structured data and inline media content", async () => {
  const services = fakeServices();
  const { client, close } = await connectedClient(services);
  const status = await client.callTool({ name: "get_whatsapp_status", arguments: {} });
  assert.deepEqual(status.structuredContent, { ok: true, data: { paired: true } });

  const history = await client.callTool({
    name: "fetch_older_whatsapp_messages",
    arguments: { chatId: "11111111-1111-4111-8111-111111111111", limit: 25 },
  });
  assert.equal(history.structuredContent.data.outcome, "received");
  assert.equal(services.calls.fetchOlderMessages, 1);

  const resync = await client.callTool({ name: "resync_whatsapp_messages", arguments: {} });
  assert.equal(resync.structuredContent.data.authoritative, false);
  assert.equal(services.calls.resyncMessages, 1);

  const media = await client.callTool({ name: "get_whatsapp_media", arguments: { messageId: "m1" } });
  assert.equal(media.structuredContent.data.delivery, "inline");
  assert.equal(media.content[1].type, "image");
  assert.equal(media.content[1].data, Buffer.from("image").toString("base64"));

  const prepared = await client.callTool({
    name: "prepare_whatsapp_text_send",
    arguments: { chatId: "chat-1", text: "hello" },
  });
  assert.equal(prepared.structuredContent.data.pendingId, "11111111-1111-4111-8111-111111111111");
  assert.equal(services.calls.prepareText, 1);

  const review = await client.callTool({
    name: "open_whatsapp_send_review",
    arguments: { kind: "text", e164: "+12025550123", text: "hello" },
  });
  assert.deepEqual(review.structuredContent.data, {
    reviewId: "22222222-2222-4222-8222-222222222222",
    state: "awaiting_human",
    expiresAt: "2026-01-01T00:10:00.000Z",
    browserOpened: true,
  });
  assert.equal(JSON.stringify(review).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(review).includes("action"), false);
  assert.equal(services.calls.openReview, 1);
  await close();
});

test("unknown service failures are sanitized", async () => {
  const services = fakeServices();
  services.reader.getStatus = async () => { throw new Error("secret path /private/data and auth token"); };
  const { client, close } = await connectedClient(services);
  const result = await client.callTool({ name: "get_whatsapp_status", arguments: {} });
  const serialized = JSON.stringify(result);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "internal_error");
  assert.equal(serialized.includes("/private/data"), false);
  assert.equal(serialized.includes("auth token"), false);
  await close();
});

test("unknown resource-read failures are sanitized", async () => {
  const services = fakeServices();
  services.media.readResource = async () => {
    throw new Error("secret resource path /private/whatsapp-media and credential");
  };
  const { client, close } = await connectedClient(services);
  await assert.rejects(
    () => client.readResource({ uri: "whatsapp-media://message/m1" }),
    (error) => {
      assert.equal(String(error).includes("/private/whatsapp-media"), false);
      assert.equal(String(error).includes("credential"), false);
      assert.match(String(error), /could not complete/i);
      return true;
    },
  );
  await close();
});

function fakeServices() {
  const calls = { fetchOlderMessages: 0, resyncMessages: 0, prepareText: 0, openReview: 0 };
  return {
    calls,
    reader: {
      async getStatus() { return { paired: true }; },
      async listChats(input) { return { chats: [], input }; },
      async readChat(input) { return { messages: [], input }; },
      async fetchOlderMessages(input) {
        calls.fetchOlderMessages += 1;
        return { outcome: "received", input };
      },
      async resyncMessages() {
        calls.resyncMessages += 1;
        return { outcome: "refreshed_non_authoritative", authoritative: false };
      },
      async searchMessages(input) { return { messages: [], input }; },
    },
    media: {
      async get(messageId) {
        return {
          delivery: "inline",
          metadata: {
            messageId,
            mimeType: "image/png",
            size: 5,
            mediaType: "image",
            sha256: "a".repeat(64),
          },
          bytes: Buffer.from("image"),
        };
      },
      async readResource(messageId) {
        return {
          metadata: {
            messageId,
            mimeType: "application/pdf",
            size: 3,
            mediaType: "document",
            sha256: "b".repeat(64),
          },
          bytes: Buffer.from("pdf"),
        };
      },
    },
    sends: {
      async prepareText(input) {
        calls.prepareText += 1;
        return prepared(input);
      },
      async prepareMedia(input) { return prepared(input); },
      async sendPrepared() { return { state: "sent", whatsappMessageId: "wa-1" }; },
      async discard() { return { discarded: true }; },
      async list() { return { sends: [] }; },
    },
    reviews: {
      async open() {
        calls.openReview += 1;
        return {
          reviewId: "22222222-2222-4222-8222-222222222222",
          state: "awaiting_human",
          expiresAt: "2026-01-01T00:10:00.000Z",
          browserOpened: true,
        };
      },
    },
  };
}

function prepared(input) {
  return {
    pendingId: "11111111-1111-4111-8111-111111111111",
    digest: "a".repeat(64),
    expiresAt: "2026-01-01T00:10:00.000Z",
    preview: input,
    approvalPreview: "exact preview",
  };
}

async function connectedClient(services) {
  const server = createWhatsAppMcpServer({ services });
  const client = new Client({ name: "safe-whatsapp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = createTransportPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

class MemoryTransport {
  peer;
  onmessage;
  onclose;
  onerror;

  async start() {}

  async send(message) {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close() {
    this.onclose?.();
  }
}

function createTransportPair() {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
