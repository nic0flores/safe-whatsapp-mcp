import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWhatsAppMcpServer, MCP_SERVER_INSTRUCTIONS } from "../dist/mcp/server.js";
import { expectedToolNames } from "../dist/mcp/tools.js";

test("hardened MCP exposes exactly five read-only tools", async () => {
  const { client, close } = await connectedClient(fakeServices());
  const response = await client.listTools();
  const tools = new Map(response.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual([...tools.keys()].sort(), [...expectedToolNames()].sort());
  assert.equal(tools.size, 5);
  for (const tool of tools.values()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  assert.equal(tools.get("get_whatsapp_status").annotations.openWorldHint, false);
  for (const name of [
    "list_whatsapp_chats",
    "read_whatsapp_chat",
    "fetch_older_whatsapp_messages",
    "search_whatsapp_messages",
  ]) {
    assert.equal(tools.get(name).annotations.openWorldHint, true);
  }
  for (const forbidden of [
    "get_whatsapp_media",
    "resync_whatsapp_messages",
    "prepare_whatsapp_text_send",
    "prepare_whatsapp_media_send",
    "open_whatsapp_send_review",
    "send_prepared_whatsapp_message",
    "discard_prepared_whatsapp_message",
  ]) {
    assert.equal(tools.has(forbidden), false);
  }
  assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
  assert.match(client.getInstructions(), /read-only/u);
  assert.match(client.getInstructions(), /allowlisted/u);
  assert.match(client.getInstructions(), /untrusted data/u);
  assert.match(client.getInstructions(), /senderE164/u);
  assert.ok(client.getInstructions().length <= 512);
  await close();
});

test("read-only tools return structured data", async () => {
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

  const search = await client.callTool({
    name: "search_whatsapp_messages",
    arguments: {
      chatId: "11111111-1111-4111-8111-111111111111",
      query: "plexos",
      limit: 10,
    },
  });
  assert.deepEqual(search.structuredContent.data.messages, []);
  assert.equal(services.calls.searchMessages, 1);
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

function fakeServices() {
  const calls = { fetchOlderMessages: 0, searchMessages: 0 };
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
      async resyncMessages() { throw new Error("disabled"); },
      async searchMessages(input) {
        calls.searchMessages += 1;
        return { messages: [], input };
      },
    },
  };
}

async function connectedClient(services) {
  const server = createWhatsAppMcpServer({ services });
  const client = new Client({ name: "safe-whatsapp-hardened-test", version: "0.0.0" });
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
