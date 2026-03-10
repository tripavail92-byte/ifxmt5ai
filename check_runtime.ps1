Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

Write-Host '=== Relay Health ===' -ForegroundColor Cyan
try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8082/health
    $health.Content
} catch {
    Write-Warning ("Relay health check failed: {0}" -f $_.Exception.Message)
}

Write-Host ''
Write-Host '=== Runtime Processes ===' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object {
        $_.CommandLine -match 'runtime\\price_relay\.py|main\.py supervisor|runtime\\job_worker\.py'
    } |
    Select-Object ProcessId, CommandLine | Format-Table -AutoSize

Write-Host ''
Write-Host '=== Relay Port 8082 ===' -ForegroundColor Cyan
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess | Format-Table -AutoSize
