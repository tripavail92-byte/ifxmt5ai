# watchdog_relay.ps1
# Runs every 60s via Task Scheduler (Windows minimum = 1 min).
# Checks relay and cloudflared health, restarts either if dead.
# Logs to logs\watchdog.log (rotates at 500KB).

$VENV_PYTHON   = "C:\mt5system\.venv\Scripts\python.exe"
$RELAY_SCRIPT  = "C:\mt5system\runtime\price_relay.py"
$START_CF      = "C:\mt5system\start_cloudflared.ps1"
$RELAY_URL     = "http://localhost:8082/health"
$LOG           = "C:\mt5system\logs\watchdog.log"
$LOG_MAX_BYTES = 512000

function Write-Log {
    param([string]$Msg, [string]$Level = "INFO")
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts [$Level] $Msg"
    Add-Content -Path $LOG -Value $line
    Write-Host $line
}

# Rotate log if too large
if ((Test-Path $LOG) -and (Get-Item $LOG).Length -gt $LOG_MAX_BYTES) {
    Move-Item $LOG "$LOG.old" -Force
}

# Ensure log dir exists
$logDir = Split-Path $LOG
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

Write-Log "--- watchdog tick ---"

# ----- 1. Check relay health --------------------------------------------------
$relayOk = $false
try {
    $resp    = Invoke-RestMethod -Uri $RELAY_URL -TimeoutSec 5 -ErrorAction Stop
    $relayOk = ($resp.status -eq "ok")
    if ($relayOk) {
        Write-Log "Relay OK (uptime=$($resp.uptime_s)s ticks=$($resp.tick_batches))"
    }
} catch {
    Write-Log "Relay health check failed: $_" "WARN"
}

if (-not $relayOk) {
    Write-Log "Relay is DOWN - killing stale processes and restarting..." "ERROR"

    Get-WmiObject Win32_Process | Where-Object {
        $_.CommandLine -like "*price_relay.py*"
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Log "Killed stale relay PID $($_.ProcessId)"
    }

    Start-Sleep -Seconds 2

    Start-Process -FilePath $VENV_PYTHON `
        -ArgumentList $RELAY_SCRIPT `
        -WorkingDirectory "C:\mt5system" `
        -WindowStyle Hidden

    Write-Log "Relay restart issued - waiting 6s to verify..."
    Start-Sleep -Seconds 6

    try {
        $check   = Invoke-RestMethod -Uri $RELAY_URL -TimeoutSec 5 -ErrorAction Stop
        $relayOk = ($check.status -eq "ok")
        if ($relayOk) {
            Write-Log "Relay recovered successfully"
        } else {
            Write-Log "Relay started but returned unexpected status" "WARN"
        }
    } catch {
        Write-Log "Relay still not responding after restart: $_" "ERROR"
    }
}

# ----- 2. Check cloudflared ---------------------------------------------------
$cfProc  = Get-Process cloudflared -ErrorAction SilentlyContinue
$cfAlive = ($null -ne $cfProc)

if ($cfAlive) {
    $pids = ($cfProc.Id -join ",")
    Write-Log "Cloudflared OK (PID=$pids)"
} else {
    Write-Log "Cloudflared is DOWN - restarting..." "ERROR"
    if ($relayOk) {
        Start-Process powershell.exe `
            -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -File `"$START_CF`"" `
            -WorkingDirectory "C:\mt5system" `
            -WindowStyle Hidden
        Write-Log "start_cloudflared.ps1 launched (Railway env vars will be updated)"
    } else {
        Write-Log "Skipping cloudflared restart - relay still down" "WARN"
    }
}

Write-Log "--- watchdog done ---"