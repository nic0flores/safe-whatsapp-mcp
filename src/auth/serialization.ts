// Agent context note: Round-trips Baileys buffers and protobuf-shaped auth/message values through JSON. Tests: test/core-database-auth.test.mjs. Always use Baileys BufferJSON for cryptographic state; update this note after meaningful changes.
import { BufferJSON } from "baileys";

export function encodeBaileys(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

export function decodeBaileys<T>(json: string): T {
  return JSON.parse(json, BufferJSON.reviver) as T;
}
