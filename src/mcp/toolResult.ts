// Agent context note: Converts service values and sanitized failures into MCP text plus structured content. Tests: test/mcp-tools.test.mjs. Unknown errors must never leak paths, credentials, message content, or transport internals; update this note after meaningful behavior changes.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { publicError } from "../errors.js";

export function successResult(
  value: Record<string, unknown>,
  additionalContent: CallToolResult["content"] = [],
): CallToolResult {
  const structuredContent = { ok: true, data: value };
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent, null, 2) },
      ...additionalContent,
    ],
    structuredContent,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const failure = publicError(error);
  const structuredContent = { ok: false, error: failure };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}
