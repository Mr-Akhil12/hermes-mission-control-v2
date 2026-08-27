$ErrorActionPreference = "Stop"

$HermesHome = if ($env:HERMES_HOME) {
    $env:HERMES_HOME
} else {
    Join-Path $env:LOCALAPPDATA "hermes"
}
$env:HERMES_HOME = $HermesHome
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$LogRoot = Join-Path $HermesHome "logs"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

function Read-HermesSetting([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    $prefix = "$Name="
    $line = Get-Content -LiteralPath $Path | Where-Object {
        $_.TrimStart().StartsWith($prefix, [StringComparison]::Ordinal)
    } | Select-Object -First 1
    if (-not $line) { return "" }
    return $line.Substring($line.IndexOf("=") + 1).Trim().Trim('"').Trim("'")
}

$env:TURSO_URL = "https://akhils-budget-mr-akhil12.aws-ap-northeast-1.turso.io"
$env:TURSO_TOKEN = Read-HermesSetting (Join-Path $HermesHome "secrets.md") "TURSO_AUTH_TOKEN"
$env:API_SERVER_KEY = Read-HermesSetting (Join-Path $HermesHome ".env") "API_SERVER_KEY"
$env:STATE_BRIDGE_TOKEN = Read-HermesSetting (Join-Path $HermesHome "secrets.md") "STATE_BRIDGE_TOKEN"
$env:ALLOWED_ORIGIN = "https://hermes-mission-control-v2.vercel.app"
$env:NATIVE_URL = "http://127.0.0.1:19119"
$env:HERMES_API_URL = "http://127.0.0.1:18642"
$env:STATE_PORT = "18645"

$Python = Join-Path $HermesHome "hermes-agent\venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
    $Python = (Get-Command python.exe -ErrorAction Stop).Source
}

function Start-BridgeChild([string[]]$Arguments, [string]$Name) {
    Start-Process -FilePath $Python -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $LogRoot "$Name.out.log") `
        -RedirectStandardError (Join-Path $LogRoot "$Name.err.log")
}

$StateServer = Start-BridgeChild @("bridge\state_server.py") "mission-control-v2-state"
$BridgeLoop = Start-BridgeChild @("bridge\bridge.py", "loop") "mission-control-v2-bridge"

try {
    while ($true) {
        Start-Sleep -Seconds 10
        if ($StateServer.HasExited) {
            $StateServer = Start-BridgeChild @("bridge\state_server.py") "mission-control-v2-state"
        }
        if ($BridgeLoop.HasExited) {
            $BridgeLoop = Start-BridgeChild @("bridge\bridge.py", "loop") "mission-control-v2-bridge"
        }
    }
} finally {
    foreach ($Child in @($StateServer, $BridgeLoop)) {
        if ($Child -and -not $Child.HasExited) {
            Stop-Process -Id $Child.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
