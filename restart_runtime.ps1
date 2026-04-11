Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

Write-Host 'Local runtime restart is deprecated.' -ForegroundColor Yellow
Write-Host 'Current architecture is MT5 EA -> Railway only.' -ForegroundColor Yellow
Write-Host 'Stopping any stray local relay/supervisor/scheduler processes instead...' -ForegroundColor Cyan

Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
	Where-Object {
		$_.CommandLine -match 'main\.py supervisor|main\.py scheduler|runtime\\price_relay\.py|runtime\\job_worker\.py'
	} |
	ForEach-Object {
		Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
	}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
	Where-Object {
		$_.CommandLine -match 'main\.py supervisor|main\.py scheduler|runtime\\price_relay\.py|runtime\\job_worker\.py'
	} |
	ForEach-Object {
		Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
	}

Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue |
	Select-Object -ExpandProperty OwningProcess -Unique |
	ForEach-Object {
		Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
	}

Write-Host ''
Write-Host 'Cleanup complete.' -ForegroundColor Green
Write-Host 'No local relay or supervisor was started.' -ForegroundColor Green
Write-Host 'Use MT5 with the public Railway endpoints only.' -ForegroundColor Yellow
