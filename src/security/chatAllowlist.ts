// Agent context note: Enforces the hardened direct-chat access policy before chat content can reach MCP or persistence. V3 supports explicit all-direct mode while always denying groups; allowlist mode remains available for narrower deployments.
import { SafeWhatsAppError } from "../errors.js";

export const ALLOWED_DIRECT_E164_ENV = "SAFE_WHATSAPP_MCP_ALLOWED_DIRECT_E164";
export const DIRECT_CHAT_POLICY_ENV = "SAFE_WHATSAPP_MCP_DIRECT_CHAT_POLICY";
const E164 = /^\+[1-9]\d{6,14}$/u;
const MAX_ENTRIES = 64;

export type DirectChatPolicyMode = "allowlist" | "all";

export interface AllowlistChat {
  kind: "direct" | "group";
  e164?: string;
}

export class DirectChatAllowlist {
  private constructor(
    readonly mode: DirectChatPolicyMode,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): DirectChatAllowlist {
    const requestedMode = environment[DIRECT_CHAT_POLICY_ENV]?.trim().toLowerCase();
    if (requestedMode !== undefined && requestedMode !== "" &&
        requestedMode !== "allowlist" && requestedMode !== "all") {
      throw new SafeWhatsAppError(
        `${DIRECT_CHAT_POLICY_ENV} must be either "allowlist" or "all".`,
        "invalid_chat_access_policy",
      );
    }
    const mode: DirectChatPolicyMode = requestedMode === "all" ? "all" : "allowlist";
    const raw = environment[ALLOWED_DIRECT_E164_ENV]?.trim() ?? "";
    if (!raw) return new DirectChatAllowlist(mode, new Set());
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
    return new DirectChatAllowlist(mode, new Set(values));
  }

  get size(): number {
    return this.allowed.size;
  }

  values(): string[] {
    return [...this.allowed].sort();
  }

  allowsE164(e164: string | undefined): boolean {
    if (this.mode === "all") return true;
    return typeof e164 === "string" && this.allowed.has(e164);
  }

  allows(chat: AllowlistChat | undefined): boolean {
    if (chat?.kind !== "direct") return false;
    return this.mode === "all" || this.allowsE164(chat.e164);
  }

  filter<T extends AllowlistChat>(chats: readonly T[]): T[] {
    return chats.filter((chat) => this.allows(chat));
  }

  assertAllowed(chat: AllowlistChat | undefined): void {
    if (this.allows(chat)) return;
    throw new SafeWhatsAppError(
      this.mode === "all"
        ? "Only direct WhatsApp chats are available through this connector."
        : "This WhatsApp chat is not in the explicit direct-chat allowlist.",
      "chat_not_allowed",
    );
  }
}
