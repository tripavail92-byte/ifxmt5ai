# start_cloudflared.ps1
# Starts the Cloudflare quick tunnel, captures the new URL,
# automatically updates Railway env vars, and triggers a redeploy.
# Run this on every boot — no manual URL updates needed.

$RELAY      = "C:\mt5system\cloudflared.exe"
$LOG_ERR    = "C:\mt5system\logs\cloudflared_err.log"
$LOG_OUT    = "C:\mt5system\logs\cloudflared_out.log"
$RAILWAY    = (Get-Command railway -ErrorAction SilentlyContinue)?.Source
$RAIL_DIR   = "C:\mt5system\frontend"   # directory containing railway.json / .railway

if (-not (Test-Path $RELAY)) {
    Write-Error "cloudflared.exe not found at $RELAY"
    exit 1
}

# ── Kill any existing cloudflared ──────────────────────────────────────────────
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# ── Clear old logs so we don't pick up a stale URL ────────────────────────────
"" | Set-Content $LOG_ERR
"" | Set-Content $LOG_OUT

Write-Host "Starting Cloudflare Tunnel -> http://localhost:8082 ..."

Start-Process -FilePath $RELAY `
    -WorkingDirectory "C:\mt5system" `
    -ArgumentList "tunnel --url http://localhost:8082 --no-autoupdate" `
    -RedirectStandardOutput $LOG_OUT `
    -RedirectStandardError  $LOG_ERR `
    -NoNewWindow

# ── Wait up to 30s for URL to appear in log ───────────────────────────────────
Write-Host "Waiting for tunnel URL..."
$url     = $null
$elapsed = 0
while (-not $url -and $elapsed -lt 30) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $url = Get-Content $LOG_ERR -ErrorAction SilentlyContinue |
           Select-String "trycloudflare\.com" |
           ForEach-Object { [regex]::Match($_.Line, 'https://[^\s]+trycloudflare\.com').Value } |
           Where-Object { $_ -ne "" } |
           Select-Object -First 1
}

if (-not $url) {
    Write-Error "Tunnel started but URL not found after 30s. Check $LOG_ERR"
    exit 1
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  TUNNEL URL: $url"
Write-Host "======================================================"

$streamUrl = "$url/stream"

# ── Update Railway env vars ───────────────────────────────────────────────────
if ($RAILWAY) {
    Write-Host ""
    Write-Host "Updating Railway env vars..."
    Push-Location $RAIL_DIR
    try {
        & $RAILWAY variables set "RELAY_STREAM_URL=$streamUrl" "PRICE_RELAY_URL=$url" 2>&1 |
            Tee-Object -Variable railOut | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "railway variables set failed" }

        Write-Host "Triggering Railway redeploy..."
        & $RAILWAY up --detach 2>&1 | Write-Host
        Write-Host "Railway redeploy triggered. Live in ~60s."
    } catch {
        Write-Warning "Railway update failed: $_"
        Write-Host "Set manually:"
        Write-Host "  RELAY_STREAM_URL=$streamUrl"
        Write-Host "  PRICE_RELAY_URL=$url"
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "railway CLI not found in PATH — update Railway manually:"
    Write-Host "  RELAY_STREAM_URL=$streamUrl"
    Write-Host "  PRICE_RELAY_URL=$url"
}

Write-Host ""
Write-Host "Tunnel is running. Cloudflared PID: $((Get-Process cloudflared -ErrorAction SilentlyContinue).Id -join ', ')"
