// Agent context note: Shared package, public CLI, MCP composition, Codex registration, and standalone handoff constants. Tests: CLI, version, Codex setup, and standalone layout suites. Keep the package/server version aligned and keep safewhatsapp as the sole public command.
export const PACKAGE_NAME = "safe-whatsapp-mcp";
export const CLI_NAME = "safewhatsapp";
export const APP_NAME = "Safe WhatsApp MCP";
export const VERSION = "0.2.3";

export const SEND_ENABLED_ENV = "SAFE_WHATSAPP_MCP_ENABLE_SEND";
export const MEDIA_SEND_ENABLED_ENV = "SAFE_WHATSAPP_MCP_ENABLE_MEDIA_SEND";
export const CODEX_SETUP_MARKER_ENV = "SAFE_WHATSAPP_MCP_CODEX_SETUP";
export const CODEX_SETUP_MARKER_VALUE = "safe-whatsapp-mcp/v1";
export const STATE_DIR_ENV = "SAFE_WHATSAPP_MCP_STATE_DIR";
export const STANDALONE_EXECUTABLE_ENV = "SAFE_WHATSAPP_MCP_STANDALONE_EXECUTABLE";
export const STANDALONE_BUNDLE_ENV = "SAFE_WHATSAPP_MCP_STANDALONE_BUNDLE";
