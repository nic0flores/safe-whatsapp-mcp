$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code $LASTEXITCODE: $Command $($Arguments -join ' ')"
    }
}

$expectedBranch = "hardening/read-only-v1"
$currentBranch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not determine current Git branch." }
if ($currentBranch -ne $expectedBranch) {
    throw "Expected branch '$expectedBranch' but current branch is '$currentBranch'."
}

if (-not (git diff --quiet)) {
    throw "Working tree has uncommitted changes. Commit/stash them before running this repair."
}
if (-not (git diff --cached --quiet)) {
    throw "Git index has staged changes. Commit/stash them before running this repair."
}

Write-Host "Updating local hardened branch from GitHub..."
Invoke-NativeChecked git pull --ff-only origin $expectedBranch

Write-Host "Pinning patched production dependencies..."
Invoke-NativeChecked npm pkg set "dependencies.sharp=0.35.4"
Invoke-NativeChecked npm pkg set "overrides.qs=^6.16.0"

Write-Host "Regenerating npm shrinkwrap without running package scripts..."
Invoke-NativeChecked npm install --package-lock-only --ignore-scripts

Write-Host "Running the fail-closed hardened Windows gate..."
& "$PSScriptRoot\verify-hardened-windows.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Hardened Windows verification did not complete successfully."
}

Write-Host "Checking patch integrity..."
Invoke-NativeChecked git diff --check

& git diff --quiet -- package.json npm-shrinkwrap.json
$dependencyFilesChanged = $LASTEXITCODE -ne 0
if ($dependencyFilesChanged) {
    Invoke-NativeChecked git add package.json npm-shrinkwrap.json
    Invoke-NativeChecked git commit -m "deps: patch sharp and qs security advisories"
    Invoke-NativeChecked git push origin $expectedBranch
    Write-Host "Security dependency repair committed and pushed." -ForegroundColor Green
} else {
    Write-Host "Dependency files were already current; nothing to commit." -ForegroundColor Green
}
