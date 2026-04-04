Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

try {
	Start-Service cloudflared -ErrorAction SilentlyContinue
} catch {
}

$watchdogTask = Get-ScheduledTask -TaskName 'IFX-RelayWatchdog' -ErrorAction SilentlyContinue
if ($watchdogTask) {
	Start-ScheduledTask -TaskName 'IFX-RelayWatchdog'
} else {
	Start-Process powershell.exe -ArgumentList @(
		'-NonInteractive',
		'-ExecutionPolicy', 'Bypass',
		'-WindowStyle', 'Hidden',
		'-File', (Join-Path $Root 'start_relay_agent.ps1')
	) | Out-Null
}

Start-Sleep -Seconds 8
& (Join-Path $Root 'start_exness_mt5.ps1')
