<#
  One-time setup for this MCP server on a new machine. Checks Node.js and
  Claude Code are installed, runs npm install, walks you through
  sources.json if you don't already have one, and registers the server
  with Claude Code. Safe to re-run: it never overwrites an existing
  sources.json, and it never overwrites an existing Claude Code MCP
  registration under the same name (see README.md "Quick install" for
  exactly what each step below does and why).

  Usage:
    .\setup.cmd                    (double-click, or from cmd/PowerShell)
    .\setup.ps1                    (run directly from PowerShell)
    .\setup.ps1 -DryRun            (show what it would do, change nothing)
    .\setup.ps1 -McpName my-mssql  (register under a different tool name)
#>
param(
  [switch]$DryRun,
  [string]$McpName = 'mssql'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$skipRegister = $false

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Ok($text) { Write-Host "    OK: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "    $text" -ForegroundColor Red; exit 1 }

Write-Host "mssql-mcp-integrated-auth setup" -ForegroundColor Cyan
Write-Host "This will:"
Write-Host "  1. Check Node.js 18+ and Claude Code are installed"
Write-Host "  2. Run 'npm install' in this folder"
Write-Host "  3. Walk you through sources.json, if you don't already have one"
Write-Host "  4. Register this server with Claude Code as '$McpName' (skipped if that name is already taken)"
if ($DryRun) { Write-Host "`nDRY RUN: nothing below will actually change anything." -ForegroundColor Yellow }

# --- 1. Node.js -------------------------------------------------------------
Step 1 "Checking Node.js..."
try {
  $nodeVersion = (node --version) -replace 'v', ''
  $major = [int]($nodeVersion.Split('.')[0])
  if ($major -lt 18) { Fail "Node.js $nodeVersion found, but 18+ is required. Get it from https://nodejs.org/" }
  Ok "Node.js $nodeVersion"
} catch {
  Fail "Node.js not found on PATH. Install it from https://nodejs.org/ (18 or later), then re-run this script."
}

# --- 2. Claude Code ----------------------------------------------------------
Step 2 "Checking Claude Code..."
try {
  $claudeVersion = claude --version
  Ok "Claude Code found ($claudeVersion)"
} catch {
  Warn "Claude Code ('claude' command) not found on PATH."
  Warn "npm install and sources.json below will still work, but the last step"
  Warn "(registering with Claude Code) will be skipped. Install Claude Code"
  Warn "first (https://docs.claude.com/en/docs/claude-code), then run:"
  Warn "  claude mcp add $McpName -s user -- node `"$root\mssql-server.mjs`""
  $skipRegister = $true
}

# --- 3. npm install ----------------------------------------------------------
Step 3 "Installing npm dependencies..."
if ($DryRun) {
  Info "Would run: npm install (in $root)"
} else {
  Push-Location $root
  npm install
  $npmExit = $LASTEXITCODE
  Pop-Location
  if ($npmExit -ne 0) { Fail "npm install failed, see output above." }
  Ok "Dependencies installed"
}

# --- 4. sources.json ---------------------------------------------------------
Step 4 "Checking sources.json..."
$sourcesPath = Join-Path $root 'sources.json'
if (Test-Path $sourcesPath) {
  Ok "sources.json already exists, leaving it alone. Edit it by hand if you need to add or change an environment."
} elseif ($DryRun) {
  Info "Would prompt you to add one or more environments and write sources.json."
} else {
  Info "No sources.json yet. Let's add your environments (dev, qa, prod, or whatever you call them)."
  Info "Press Enter with a blank id when you're done adding environments."
  $envs = @()
  while ($true) {
    $id = Read-Host "  Environment id (e.g. dev) [blank to finish]"
    if ([string]::IsNullOrWhiteSpace($id)) { break }
    $hostName = Read-Host "  SQL Server host for '$id' (e.g. sql-dev.example.internal)"
    $instance = Read-Host "  Named instance for '$id' (blank for default instance)"
    $db = Read-Host "  Default database for '$id' (blank for master)"
    $entry = [ordered]@{ id = $id; host = $hostName }
    if ($instance) { $entry.instanceName = $instance }
    if ($db) { $entry.database = $db }
    $envs += $entry
  }
  if ($envs.Count -eq 0) {
    Warn "No environments entered. Copying sources.example.json as a starting point instead;"
    Warn "edit it by hand before using this server."
    Copy-Item (Join-Path $root 'sources.example.json') $sourcesPath
  } else {
    # Deliberately not "Set-Content -Encoding utf8": on Windows PowerShell
    # 5.1 (the Windows default, as opposed to PowerShell 7+) that writes a
    # UTF-8 byte-order mark, and Node's JSON.parse does not strip a BOM,
    # so mssql-server.mjs would fail to start with a cryptic "Unexpected
    # token" error on its very first run. Write UTF-8 without a BOM
    # explicitly instead, which works the same on both PowerShell versions.
    $json = ConvertTo-Json -InputObject $envs -Depth 5
    [System.IO.File]::WriteAllText($sourcesPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Ok "Wrote sources.json with $($envs.Count) environment(s)."
  }
}

# --- 5. Register with Claude Code --------------------------------------------
Step 5 "Registering with Claude Code..."
if ($skipRegister) {
  Warn "Skipped (Claude Code not found earlier)."
} elseif ($DryRun) {
  Info "Would check whether '$McpName' is already registered, and if not, run:"
  Info "  claude mcp add $McpName -s user -- node `"$root\mssql-server.mjs`""
} else {
  claude mcp get $McpName *> $null
  if ($LASTEXITCODE -eq 0) {
    Warn "A tool named '$McpName' is already registered with Claude Code. Not touching it."
    Warn "Run 'claude mcp get $McpName' to see what it currently points at. If this is a"
    Warn "leftover from something else, either:"
    Warn "  - remove it first:  claude mcp remove $McpName -s user"
    Warn "  - or register this copy under a different name:  .\setup.ps1 -McpName my-mssql"
  } else {
    claude mcp add $McpName -s user -- node "$root\mssql-server.mjs"
    if ($LASTEXITCODE -ne 0) { Fail "claude mcp add failed, see output above." }
    Ok "Registered as '$McpName'."
  }
}

Write-Host "`nDone." -ForegroundColor Cyan
if (-not $DryRun) {
  Write-Host "Open a new Claude Code session and ask it to run list_environments, then"
  Write-Host "list_databases against one environment, to confirm it can reach SQL Server."
  Write-Host "See README.md 'Which account Claude runs as' if that fails with a login error."
  Write-Host "For a deeper check: npm run smoke-test"
}
