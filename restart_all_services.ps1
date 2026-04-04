# Comprehensive system restart script
# Restarts relay, supervisor, and cloudflared

Write-Host "$(Get-Date) === RESTARTING ALL SERVICES ===" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log

# 1. Kill all Python processes
Write-Host "Killing Python workers..."
Get-Process python.exe -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 2. Kill cloudflared if running
Write-Host "Restarting cloudflared..."
Stop-Service cloudflared -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Service cloudflared -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 3. Start relay with venv
Write-Host "Starting price relay..."
$venvPython = "C:\mt5system\.venv\Scripts\python.exe"
Start-Process -FilePath $venvPython `
    -ArgumentList "runtime/price_relay.py" `
    -WorkingDirectory "C:\mt5system" `
    -RedirectStandardOutput "C:\mt5system\logs\relay.log" `
    -RedirectStandardError "C:\mt5system\logs\relay_err.log" `
    -NoNewWindow

Start-Sleep -Seconds 10

# 4. Start supervisor
Write-Host "Starting supervisor..."
Start-Process -FilePath $venvPython `
    -ArgumentList "runtime/supervisor.py" `
    -WorkingDirectory "C:\mt5system" `
    -RedirectStandardOutput "C:\mt5system\logs\supervisor.log" `
    -RedirectStandardError "C:\mt5system\logs\supervisor_err.log" `
    -NoNewWindow

Write-Host "$(Get-Date) Services restarted" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log
Start-Sleep -Seconds 5

# 5. Quick status check
Write-Host ""
Write-Host "Service Status:"
$pythonCount = @(Get-Process python.exe -ErrorAction SilentlyContinue).Count
Write-Host "  Python processes: $pythonCount" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log

$cloudflareStatus = (Get-Service cloudflared -ErrorAction SilentlyContinue).Status
Write-Host "  Cloudflared status: $cloudflareStatus" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log
