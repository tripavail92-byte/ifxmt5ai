# watchdog_relay.ps1
# Runs every 60s via Task Scheduler (Windows minimum = 1 min).
# Checks relay and cloudflared health, restarts either if dead.
# Logs to logs\watchdog.log (rotates at 500KB).

$VENV_PYTHON   = "C:\mt5system\.venv\Scripts\python.exe"
$RELAY_SCRIPT  = "C:\mt5system\runtime\price_relay.py"
$START_CF      = "C:\mt5system\start_cloudflared.ps1"
$RELAY_URL     = "http://localhost:8082/health"
$CF_LOG_ERR    = "C:\mt5system\logs\cloudflared_err.log"
$RAIL_DIR      = "C:\mt5system"
$LOG           = "C:\mt5system\logs\watchdog.log"
$LOG_MAX_BYTES = 512000
$railwayCmd    = Get-Command railway -ErrorAction SilentlyContinue
$RAILWAY       = if ($railwayCmd) { $railwayCmd.Source } else { $null }

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

function Get-CloudflareTunnelUrl {
    if (-not (Test-Path $CF_LOG_ERR)) { return $null }
    $match = Get-Content $CF_LOG_ERR -ErrorAction SilentlyContinue |
        ForEach-Object { [regex]::Match($_, "https://[^\s]+trycloudflare\.com").Value } |
        Where-Object { $_ } |
        Select-Object -Last 1
    return $match
}

function Test-CloudflareTunnelHealth {
    param([string]$TunnelUrl)
    if (-not $TunnelUrl) { return $false }
    try {
        $resp = Invoke-RestMethod -Uri ("{0}/health" -f $TunnelUrl.TrimEnd('/')) -TimeoutSec 10 -ErrorAction Stop
        return ($resp.status -eq "ok")
    } catch {
        return $false
    }
}

function Sync-RailwayTunnelVars {
    param([string]$TunnelUrl)
    if (-not $TunnelUrl -or -not $RAILWAY) { return }

    $baseUrl = $TunnelUrl.TrimEnd('/')
    $streamUrl = "$baseUrl/stream"
    Push-Location $RAIL_DIR
    try {
        $varsRaw = & $RAILWAY variables --json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $varsRaw) {
            Write-Log "Could not read Railway vars for tunnel sync" "WARN"
            return
        }
        $vars = $varsRaw | ConvertFrom-Json
        $needsUpdate = ($vars.PRICE_RELAY_URL -ne $baseUrl) -or ($vars.RELAY_STREAM_URL -ne $streamUrl) -or ($vars.NEXT_PUBLIC_PRICE_RELAY_URL -ne $baseUrl)
        if (-not $needsUpdate) { return }

        Write-Log "Railway relay URL mismatch detected - syncing to $baseUrl"
        & $RAILWAY variables set "RELAY_STREAM_URL=$streamUrl" "PRICE_RELAY_URL=$baseUrl" "NEXT_PUBLIC_PRICE_RELAY_URL=$baseUrl" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Failed to update Railway relay vars" "WARN"
            return
        }
        & $RAILWAY up --detach | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Railway redeploy triggered after tunnel sync"
        } else {
            Write-Log "Railway vars updated but redeploy trigger failed" "WARN"
        }
    } catch {
        Write-Log "Railway tunnel sync failed: $_" "WARN"
    } finally {
        Pop-Location
    }
}

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
$tunnelUrl = Get-CloudflareTunnelUrl
$tunnelOk = $false
if ($cfAlive -and $tunnelUrl) {
    $tunnelOk = Test-CloudflareTunnelHealth -TunnelUrl $tunnelUrl
}

if ($cfAlive -and $tunnelOk) {
    $pids = ($cfProc.Id -join ",")
    Write-Log "Cloudflared OK (PID=$pids url=$tunnelUrl)"
    Sync-RailwayTunnelVars -TunnelUrl $tunnelUrl
} else {
    if ($cfAlive -and -not $tunnelOk) {
        Write-Log "Cloudflared process is alive but tunnel is unhealthy (url=$tunnelUrl) - restarting..." "ERROR"
        $cfProc | ForEach-Object {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            Write-Log "Killed stale cloudflared PID $($_.Id)"
        }
        Start-Sleep -Seconds 2
    } else {
        Write-Log "Cloudflared is DOWN - restarting..." "ERROR"
    }
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