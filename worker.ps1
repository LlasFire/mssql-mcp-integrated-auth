# Persistent SQL worker: reads one JSON request per line from stdin,
# keeps SqlConnections open across requests (keyed by env|database),
# writes one JSON response per line to stdout. Windows-integrated auth only.

Add-Type -AssemblyName "System.Data" -ErrorAction SilentlyContinue
$ErrorActionPreference = "Stop"

$sourcesPath = Join-Path $PSScriptRoot 'sources.json'
$sourceList = Get-Content $sourcesPath -Raw | ConvertFrom-Json
$sources = @{}
foreach ($s in $sourceList) { $sources[$s.id] = $s }

$connections = @{}
$safeIdentifier = '^[A-Za-z0-9_$#@]+$'

function Get-Conn($envName, $db) {
  $src = $sources[$envName]
  if (-not $src) { throw "Unknown environment '$envName'. Available: $($sources.Keys -join ', ')" }
  $server = if ($src.instanceName) { "$($src.host)\$($src.instanceName)" } else { $src.host }
  $dbName = if ($db) { $db } else { $src.database }
  if (-not $dbName) { $dbName = 'master' }
  # $dbName is interpolated straight into the connection string below (no
  # bound parameters here); a value like 'master;Server=attacker,1433' would
  # override Server= and redirect the integrated-auth handshake. The MCP
  # server validates this already - this is a second, independent check.
  if ($dbName -notmatch $safeIdentifier) {
    throw "Invalid database name '$dbName': must contain only letters, digits, or _ `$ # @"
  }
  $key = "$envName|$dbName"
  if ($connections.ContainsKey($key) -and $connections[$key].State -eq [System.Data.ConnectionState]::Open) {
    return $connections[$key]
  }
  $connStr = "Server=$server;Database=$dbName;Integrated Security=True;TrustServerCertificate=True;Encrypt=True;Connection Timeout=15"
  $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
  $conn.Open()
  $connections[$key] = $conn
  return $conn
}

function Invoke-Req($req) {
  $conn = Get-Conn $req.env $req.database
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $req.sql
  $cmd.CommandTimeout = 30
  $reader = $cmd.ExecuteReader()
  $rows = New-Object System.Collections.ArrayList
  $maxRows = if ($req.maxRows) { [int]$req.maxRows } else { 500 }
  $truncated = $false
  while ($reader.Read()) {
    if ($rows.Count -ge $maxRows) { $truncated = $true; break }
    $row = [ordered]@{}
    for ($i = 0; $i -lt $reader.FieldCount; $i++) {
      $val = $reader.GetValue($i)
      $row[$reader.GetName($i)] = if ($val -eq [DBNull]::Value) { $null } else { $val.ToString() }
    }
    [void]$rows.Add($row)
  }
  $reader.Close()
  return @{ ok = $true; rows = $rows; truncated = $truncated; rowCount = $rows.Count }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  try {
    $req = $line | ConvertFrom-Json
    $result = Invoke-Req $req
    Write-Output (ConvertTo-Json -InputObject $result -Depth 6 -Compress)
  } catch {
    Write-Output (ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress)
  }
  [Console]::Out.Flush()
}
