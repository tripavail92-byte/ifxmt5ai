Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
$LogDir = Join-Path $Root 'runtime\logs'
$RelayOut = Join-Path $LogDir 'relay_start_stdout.log'
$RelayErr = Join-Path $LogDir 'relay_start_stderr.log'
$SupervisorOut = Join-Path $LogDir 'supervisor_start_stdout.log'
$SupervisorErr = Join-Path $LogDir 'supervisor_start_stderr.log'

if (-not (Test-Path $VenvPython)) {
    throw "Venv python not found: $VenvPython"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

& (Join-Path $Root 'stop_all_runtime_and_mt5.ps1') | Out-Null
Start-Sleep -Seconds 2

$relay = Start-Process -FilePath $VenvPython -WorkingDirectory $Root -ArgumentList 'runtime\price_relay.py' -RedirectStandardOutput $RelayOut -RedirectStandardError $RelayErr -PassThru

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
    throw 'Relay failed to become healthy on 127.0.0.1:8082.'
}

$supervisor = Start-Process -FilePath $VenvPython -WorkingDirectory $Root -ArgumentList 'main.py','supervisor' -RedirectStandardOutput $SupervisorOut -RedirectStandardError $SupervisorErr -PassThru

"relay_pid=$($relay.Id) supervisor_pid=$($supervisor.Id) started_at=$(Get-Date -Format o)" | Set-Content -Path (Join-Path $LogDir 'runtime_autostart.state')
Write-Host 'Runtime started successfully.' -ForegroundColor Green
