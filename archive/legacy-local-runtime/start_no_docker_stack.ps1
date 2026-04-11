param(
    [string]$AgentIp = "127.0.0.1",
    [string]$AgentBaseUrl = "https://relay.myifxacademy.com",
    [string]$ControlPlaneUrl = "https://ifx-control-plane-production.up.railway.app",
    [string]$RedisUrl = "",
    [string]$RedisHost = "127.0.0.1",
    [int]$RedisPort = 6379,
    [string]$VenvPath = ".venv-no-docker"
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$controlArgs = @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "start_control_plane.ps1"),
    "-Port", "5000",
    "-VenvPath", $VenvPath
)

$relayArgs = @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "start_relay_agent.ps1"),
    "-AgentId", "relay_agent_1",
    "-AgentIp", $AgentIp,
    "-AgentPort", "8083",
    "-AgentBaseUrl", $(if ($AgentBaseUrl) { $AgentBaseUrl } else { "https://${AgentIp}:8083" }),
    "-ControlPlaneUrl", $ControlPlaneUrl,
    "-RedisUrl", $RedisUrl,
    "-RedisHost", $RedisHost,
    "-RedisPort", "$RedisPort",
    "-VenvPath", $VenvPath
)

Start-Process powershell -ArgumentList $controlArgs | Out-Null
Start-Sleep -Seconds 3
Start-Process powershell -ArgumentList $relayArgs | Out-Null

Write-Host "No-Docker stack launched." -ForegroundColor Green
Write-Host "Control plane: $ControlPlaneUrl/health"
Write-Host "Relay agent:   $(if ($AgentBaseUrl) { $AgentBaseUrl } else { "https://${AgentIp}:8083" })/health"
Write-Host "If Redis is not running, the relay agent will still start but stream persistence will be disabled."