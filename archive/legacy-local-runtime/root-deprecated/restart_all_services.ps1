# Deprecated helper kept only to prevent accidental resurrection of the old local stack.

Write-Host "$(Get-Date) === LOCAL SERVICES DEPRECATED ===" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log
Write-Host 'Current architecture is MT5 EA -> Railway only.'
Write-Host 'Stopping old local runtime processes instead of restarting relay/supervisor/cloudflared...'

Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'main\.py supervisor|main\.py scheduler|runtime\\price_relay\.py|runtime\\job_worker\.py' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

Write-Host "$(Get-Date) Local runtime cleanup complete" | Tee-Object -Append -FilePath C:\mt5system\logs\restart.log
