Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
$RelayPort = 8082

if (-not (Test-Path $VenvPython)) {
    throw "Venv python not found: $VenvPython"
}

Write-Host "[1/5] Stopping stale runtime Python processes..." -ForegroundColor Cyan
$pythonTargets = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object {
        $_.CommandLine -match 'main\.py supervisor|runtime\\price_relay\.py|runtime\\job_worker\.py'
    }
foreach ($proc in $pythonTargets) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host ("  stopped python pid={0}" -f $proc.ProcessId) -ForegroundColor DarkGray
    } catch {
        Write-Warning ("Failed to stop python pid={0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
    }
}

Write-Host "[2/5] Stopping stale launcher PowerShell windows..." -ForegroundColor Cyan
$psTargets = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object {
        $_.CommandLine -match 'main\.py supervisor|runtime\\price_relay\.py|runtime\\job_worker\.py'
    }
foreach ($proc in $psTargets) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Write-Host ("  stopped powershell pid={0}" -f $proc.ProcessId) -ForegroundColor DarkGray
    } catch {
        Write-Warning ("Failed to stop powershell pid={0}: {1}" -f $proc.ProcessId, $_.Exception.Message)
    }
}

Write-Host "[3/5] Releasing relay port $RelayPort..." -ForegroundColor Cyan
$portOwners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $RelayPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pid in $portOwners) {
    try {
        Stop-Process -Id $pid -Force -ErrorAction Stop
        Write-Host ("  released port via pid={0}" -f $pid) -ForegroundColor DarkGray
    } catch {
        Write-Warning ("Failed to stop port owner pid={0}: {1}" -f $pid, $_.Exception.Message)
    }
}

Start-Sleep -Seconds 2

Write-Host "[4/5] Starting relay in a dedicated window..." -ForegroundColor Cyan
$relay = Start-Process powershell -PassThru -ArgumentList @(
    '-NoExit',
    '-Command',
    "Set-Location -Path '$Root'; & '$VenvPython' .\runtime\price_relay.py"
)
Write-Host ("  relay launcher pid={0}" -f $relay.Id) -ForegroundColor Green

$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8082/health
        if ($resp.StatusCode -eq 200) {
            $healthy = $true
            break
        }
    } catch {
    }
}

if (-not $healthy) {
    Write-Warning 'Relay did not become healthy on http://127.0.0.1:8082/health within 40 seconds.'
    Write-Warning 'Check the new relay window or runtime\logs\price_relay.log.'
    exit 1
}

Write-Host "[5/5] Starting supervisor in a dedicated window..." -ForegroundColor Cyan
$supervisor = Start-Process powershell -PassThru -ArgumentList @(
    '-NoExit',
    '-Command',
    "Set-Location -Path '$Root'; & '$VenvPython' .\main.py supervisor"
)
Write-Host ("  supervisor launcher pid={0}" -f $supervisor.Id) -ForegroundColor Green

Write-Host ''
Write-Host 'Runtime restart complete.' -ForegroundColor Green
Write-Host 'Next check:' -ForegroundColor Yellow
Write-Host '  .\check_runtime.ps1' -ForegroundColor Yellow
