Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root
$logPath = Join-Path $Root 'runtime\logs\watchdog.log'
$timestamp = Get-Date -Format s

"[$timestamp] watchdog_relay.ps1 invoked but watchdog is deprecated in the EA-first architecture" | Out-File -FilePath $logPath -Append -Encoding utf8
Write-Host 'watchdog_relay.ps1 is deprecated.' -ForegroundColor Yellow
Write-Host 'Use .\check_runtime.ps1 for manual health checks, and keep only runtime\terminal_manager.py as the local host process.' -ForegroundColor Yellow
exit 0