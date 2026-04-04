param(
    [string]$AgentId = "relay_agent_1",
    [string]$AgentIp = "127.0.0.1",
    [int]$AgentPort = 8083,
    [int]$AgentCapacity = 8,
    [string]$AgentBaseUrl = "https://relay.myifxacademy.com",
    [string]$ControlPlaneUrl = "",
    [string]$RedisUrl = "",
    [string]$RedisHost = "127.0.0.1",
    [int]$RedisPort = 6379,
    [string]$TerminalsDir = "C:\mt5system\terminals",
    [string]$VenvPath = ".venv-no-docker"
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

function Get-DotEnvValues {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path $Path)) {
        return $values
    }

    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*#' -or $line -notmatch '=') {
            continue
        }

        $parts = $line.Split('=', 2)
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"', "'")
        if ($key) {
            $values[$key] = $value
        }
    }

    return $values
}

$envValues = Get-DotEnvValues -Path (Join-Path $PSScriptRoot '.env')

if (-not $ControlPlaneUrl) {
    $ControlPlaneUrl = if ($envValues.ContainsKey('CONTROL_PLANE_URL')) {
        $envValues['CONTROL_PLANE_URL']
    } else {
        'https://ifx-control-plane-production.up.railway.app'
    }
}

if (-not $AgentBaseUrl -or $AgentBaseUrl -eq 'http://relay.myifxacademy.com') {
    $AgentBaseUrl = if ($envValues.ContainsKey('AGENT_BASE_URL')) {
        $envValues['AGENT_BASE_URL']
    } else {
        'https://relay.myifxacademy.com'
    }
}

if (-not $RedisUrl) {
    if ($envValues.ContainsKey('REDIS_URL')) {
        $RedisUrl = $envValues['REDIS_URL']
    } elseif ($envValues.ContainsKey('REDIS_PUBLIC_URL')) {
        $RedisUrl = $envValues['REDIS_PUBLIC_URL']
    }
}

if (-not (Test-Path $VenvPath)) {
    python -m venv $VenvPath
}

$pythonExe = Join-Path $PSScriptRoot "$VenvPath\Scripts\python.exe"
$readyMarker = Join-Path $PSScriptRoot "$VenvPath\.ifx_no_docker_ready"

if (-not (Test-Path $readyMarker)) {
    & $pythonExe -m pip install --upgrade pip
    & $pythonExe -m pip install -r requirements.txt
    & $pythonExe -m pip install fastapi "uvicorn[standard]" aiohttp redis pydantic
    New-Item -ItemType File -Path $readyMarker -Force | Out-Null
}

$mt5ImportOk = $false
try {
    & $pythonExe -c "import MetaTrader5" *> $null
    $mt5ImportOk = ($LASTEXITCODE -eq 0)
} catch {
    $mt5ImportOk = $false
}

if (-not $mt5ImportOk) {
    & $pythonExe -m pip install MetaTrader5
}

$relaySourceConnId = if ($envValues.ContainsKey('RELAY_SOURCE_CONNECTION_ID')) {
    $envValues['RELAY_SOURCE_CONNECTION_ID']
} else {
    ''
}

$env:AGENT_ID = $AgentId
$env:AGENT_IP = $AgentIp
$env:AGENT_PORT = "$AgentPort"
$env:AGENT_CAPACITY = "$AgentCapacity"
$env:AGENT_BASE_URL = if ($AgentBaseUrl) { $AgentBaseUrl } else { "https://relay.myifxacademy.com" }
$env:CONTROL_PLANE_URL = $ControlPlaneUrl
$env:REDIS_URL = $RedisUrl
$env:REDIS_HOST = $RedisHost
$env:REDIS_PORT = "$RedisPort"
$env:MT5_TERMINALS_DIR = $TerminalsDir
$env:MT5_TERMINAL_BASE_DIR = $TerminalsDir
$env:RELAY_SOURCE_CONNECTION_ID = $relaySourceConnId

Write-Host "Starting relay agent $AgentId on port $AgentPort ..." -ForegroundColor Cyan
& $pythonExe runtime\new_price_relay_multitenant.py