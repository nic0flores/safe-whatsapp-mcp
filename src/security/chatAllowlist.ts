// Agent context note: Enforces the hardened direct-chat E.164 allowlist before chat content can reach MCP or persistence. Keep groups denied and fail closed on invalid or missing configuration.
import { SafeWhatsAppError } from "../errors.js";

export const ALLOWED_DIRECT_E164_ENV = "SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164";
const E164 = /^\+[1-9]\d{6,14}$/u;
const MAX_ENTRIES = 64;

export interface AllowlistChat {
  kind: "direct" | "group";
  e164?: string;
}

export class DirectChatAllowlist {
  private constructor(private readonly allowed: ReadonlySet<string>) {}

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): DirectChatAllowlist {
    const raw = environment[ALLOWED_DIRECT_E164_ENV]?.trim() ?? "";
    if (!raw) return new DirectChatAllowlist(new Set());
    const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
    if (values.length > MAX_ENTRIES) {
      throw new SafeWhatsAppError(
        `${ALLOWED_DIRECT_E164_ENV} cannot contain more than ${MAX_ENTRIES} entries.`,
        "invalid_chat_allowlist",
      );
    }
    for (const value of values) {
      if (!E164.test(value)) {
        throw new SafeWhatsAppError(
          `${ALLOWED_DIRECT_E164_ENV} must contain comma-separated canonical E.164 numbers such as +56912345678.`,
          "invalid_chat_allowlist",
        );
      }
    }
    return new DirectChatAllowlist(new Set(values));
  }

  get size(): number {
    return this.allowed.size;
  }

  values(): string[] {
    return [...this.allowed].sort();
  }

  allowsE164(e164: string | undefined): boolean {
    return typeof e164 === "string" && this.allowed.has(e164);
  }

  allows(chat: AllowlistChat | undefined): boolean {
    return chat?.kind === "direct" && this.allowsE164(chat.e164);
  }

  filter<T extends AllowlistChat>(chats: readonly T[]): T[] {
    return chats.filter((chat) => this.allows(chat));
  }

  assertAllowed(chat: AllowlistChat | undefined): void {
    if (this.allows(chat)) return;
    throw new SafeWhatsAppError(
      "This WhatsApp chat is not in the explicit direct-chat allowlist.",
      "chat_not_allowed",
    );
  }
}
