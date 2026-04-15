Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'IFX-RelayWatchdog'

try {
    schtasks /delete /tn $taskName /f 2>$null | Out-Null
} catch {
    # Ignore missing-task errors.
}

Write-Host ''
Write-Host "Task '$taskName' removed if it existed." -ForegroundColor Green
Write-Host 'The watchdog task is deprecated and is not part of the EA-first architecture.' -ForegroundColor Yellow
Write-Host 'Keep only runtime\terminal_manager.py as the local host process.' -ForegroundColor Yellow