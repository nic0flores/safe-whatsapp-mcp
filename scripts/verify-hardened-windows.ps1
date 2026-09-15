$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# PowerShell does not reliably turn native non-zero exit codes into terminating
# errors on every supported Windows/PowerShell combination. Check explicitly.
#
# Invoke npm through npm.cmd rather than npm.ps1. Windows PowerShell's npm.ps1
# shim reads $MyInvocation.Statement; under StrictMode that property can be
# absent and fail before npm itself starts.
function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

Write-Host "[1/6] Installing exact dependency tree and pinned Baileys pairing patch..."
Invoke-NativeChecked npm.cmd ci

Write-Host "[2/6] TypeScript typecheck..."
Invoke-NativeChecked npm.cmd run typecheck

Write-Host "[3/6] Building..."
Invoke-NativeChecked npm.cmd run build

Write-Host "[4/6] Running hardened V2 encrypted-cache + pairing-refresh tests..."
Invoke-NativeChecked node --test `
    test/chat-allowlist.test.mjs `
    test/hardened-persistence.test.mjs `
    test/cache-encryption.test.mjs `
    test/baileys-pairing-refresh.test.mjs `
    test/mcp-tools.test.mjs `
    test/core-config-storage.test.mjs `
    test/application.test.mjs `
    test/cli.test.mjs

Write-Host "[5/6] Auditing production dependencies..."
Invoke-NativeChecked npm.cmd audit --omit=dev

Write-Host "[6/6] Verifying exposed MCP tool names..."
$forbidden = @(
    "send_prepared_whatsapp_message",
    "prepare_whatsapp_text_send",
    "prepare_whatsapp_media_send",
    "open_whatsapp_send_review",
    "get_whatsapp_media",
    "list_whatsapp_sends",
    "resync_whatsapp_messages"
)
$source = Get-Content -Raw "src/mcp/tools.ts"
foreach ($name in $forbidden) {
    if ($source.Contains('"' + $name + '"')) {
        throw "Forbidden MCP tool is still registered: $name"
    }
}

Write-Host "HARDENED V2 PAIRING-REFRESH WINDOWS GATE: PASS" -ForegroundColor Green
Write-Host "Note: hardened CI must also pass on Linux/macOS before retrying pairing on a primary WhatsApp account."
