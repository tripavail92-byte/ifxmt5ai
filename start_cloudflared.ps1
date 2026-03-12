# start_cloudflared.ps1
# Starts the Cloudflare Tunnel that exposes the local relay's SSE stream publicly.
#
# Quick tunnel (no Cloudflare account needed):
#   - URL changes each restart  
#   - After starting, update Railway env vars:
#       RELAY_STREAM_URL = https://<new-url>.trycloudflare.com/stream
#       PRICE_RELAY_URL  = https://<new-url>.trycloudflare.com
#   - Redeploy Railway for changes to take effect.
#
# Named tunnel (permanent URL, recommended for production):
#   - Run once: cloudflared.exe tunnel login
#   - Run once: cloudflared.exe tunnel create ifx-relay
#   - Then use: cloudflared.exe tunnel run ifx-relay
#   - URL never changes — no need to update Railway env vars on restart.

$RELAY = "C:\mt5system\cloudflared.exe"
$LOG   = "C:\mt5system\logs\cloudflared_err.log"

if (-not (Test-Path $RELAY)) {
    Write-Error "cloudflared.exe not found at $RELAY"
    exit 1
}

Write-Host "Starting Cloudflare Tunnel -> http://localhost:8082 ..."
Write-Host "Logging to: $LOG"

# Kill any existing cloudflared processes
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Start-Process -FilePath $RELAY `
    -WorkingDirectory "C:\mt5system" `
    -ArgumentList "tunnel --url http://localhost:8082 --no-autoupdate" `
    -RedirectStandardOutput "C:\mt5system\logs\cloudflared_out.log" `
    -RedirectStandardError $LOG `
    -NoNewWindow

Write-Host "Waiting for tunnel URL..."
Start-Sleep -Seconds 12

$url = Get-Content $LOG | Select-String "trycloudflare.com" | 
    ForEach-Object { ($_ -replace '.*https://', 'https://') -replace '\s.*$', '' } |
    Select-Object -First 1

if ($url) {
    Write-Host ""
    Write-Host "======================================================"
    Write-Host "  TUNNEL URL: $url"
    Write-Host "======================================================"
    Write-Host ""
    Write-Host "Set these in Railway dashboard (or run railway variables set):"
    Write-Host "  RELAY_STREAM_URL=$url/stream"
    Write-Host "  PRICE_RELAY_URL=$url"
    Write-Host ""
    Write-Host "Then redeploy Railway for the changes to apply."
} else {
    Write-Host "Tunnel started — check $LOG for the URL"
}
