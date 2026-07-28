// Agent context note: Defines stable user-facing errors shared across CLI and MCP boundaries. Tests: test/errors.test.mjs. Keep sensitive values out of messages; update this note after meaningful behavior changes.
export class SafeWhatsAppError extends Error {
  constructor(
    message: string,
    readonly code = "safe_whatsapp_error",
  ) {
    super(message);
    this.name = "SafeWhatsAppError";
  }
}

export function publicError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof SafeWhatsAppError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: "Safe WhatsApp MCP could not complete the request.",
  };
}
