# start_cloudflared.ps1
# Starts the Cloudflare quick tunnel OR authenticated tunnel (if API token provided),
# automatically updates Railway env vars, and triggers a redeploy.
# Run this on every boot -- no manual URL updates needed.

# Load .env to get CLOUDFLARE_API_TOKEN if present
$envFile = "C:\mt5system\.env"
$env:CLOUDFLARE_API_TOKEN = $null
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+)') {
            $env:CLOUDFLARE_API_TOKEN = $matches[1].Trim('"', "'")
        }
    }
}

$RELAY    = "C:\mt5system\cloudflared.exe"
$LOG_ERR  = "C:\mt5system\logs\cloudflared_err.log"
$LOG_OUT  = "C:\mt5system\logs\cloudflared_out.log"
$RAIL_DIR = "C:\mt5system"

$railwayCmd = Get-Command railway -ErrorAction SilentlyContinue
$RAILWAY    = if ($railwayCmd) { $railwayCmd.Source } else { $null }

if (-not (Test-Path $RELAY)) {
    Write-Error "cloudflared.exe not found at $RELAY"
    exit 1
}

# Kill any existing cloudflared
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# Clear old logs so we do not pick up a stale URL
"" | Set-Content $LOG_ERR
"" | Set-Content $LOG_OUT

Write-Host "Starting Cloudflare Tunnel -> http://localhost:8082 ..."

if ($env:CLOUDFLARE_API_TOKEN) {
    Write-Host "Using authenticated tunnel (API token present)"
    Start-Process -FilePath $RELAY `
        -WorkingDirectory "C:\mt5system" `
        -ArgumentList "tunnel --url http://localhost:8082 --no-autoupdate" `
        -EnvironmentVariables @{ "CLOUDFLARE_API_TOKEN" = $env:CLOUDFLARE_API_TOKEN } `
        -RedirectStandardOutput $LOG_OUT `
        -RedirectStandardError  $LOG_ERR `
        -NoNewWindow
} else {
    Write-Host "Using quick tunnel (no API token)"
    Start-Process -FilePath $RELAY `
        -WorkingDirectory "C:\mt5system" `
        -ArgumentList "tunnel --url http://localhost:8082 --no-autoupdate" `
        -RedirectStandardOutput $LOG_OUT `
        -RedirectStandardError  $LOG_ERR `
        -NoNewWindow
}

# Wait up to 30s for URL to appear
Write-Host "Waiting for tunnel URL..."
$url     = $null
$elapsed = 0
while (-not $url -and $elapsed -lt 30) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $url = Get-Content $LOG_ERR -ErrorAction SilentlyContinue |
           ForEach-Object { [regex]::Match($_, "https://[^\s]+trycloudflare\.com").Value } |
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

if ($RAILWAY) {
    Write-Host ""
    Write-Host "Updating Railway env vars..."
    Push-Location $RAIL_DIR
    try {
        & $RAILWAY variables set "RELAY_STREAM_URL=$streamUrl" "PRICE_RELAY_URL=$url" "NEXT_PUBLIC_PRICE_RELAY_URL=$url"
        if ($LASTEXITCODE -ne 0) { throw "railway variables set failed" }
        Write-Host "Triggering Railway redeploy..."
        & $RAILWAY up --detach
        Write-Host "Railway redeploy triggered. Live in ~60s."
    } catch {
        Write-Warning "Railway update failed: $_"
        Write-Host "Set manually in Railway dashboard:"
        Write-Host "  RELAY_STREAM_URL=$streamUrl"
        Write-Host "  PRICE_RELAY_URL=$url"
        Write-Host "  NEXT_PUBLIC_PRICE_RELAY_URL=$url"
    } finally {
        Pop-Location
    }
} else {
    Write-Warning "railway CLI not found -- update Railway manually:"
    Write-Host "  RELAY_STREAM_URL=$streamUrl"
    Write-Host "  PRICE_RELAY_URL=$url"
    Write-Host "  NEXT_PUBLIC_PRICE_RELAY_URL=$url"
}

Write-Host ""
$cfPids = (Get-Process cloudflared -ErrorAction SilentlyContinue).Id -join ", "
Write-Host "Tunnel is running. Cloudflared PID: $cfPids"
