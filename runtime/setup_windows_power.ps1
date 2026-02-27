# setup_windows_power.ps1
# IFX MT5 Runtime — One-time Windows power settings
# Run once as Administrator on the VPS before starting services.
#
# Usage:
#   Right-click PowerShell → Run as Administrator
#   .\setup_windows_power.ps1

Write-Host "Configuring Windows power settings for IFX MT5 Runtime..." -ForegroundColor Cyan

# Disable sleep on AC power
powercfg /change standby-timeout-ac 0
Write-Host "[OK] Sleep on AC: disabled"

# Disable monitor timeout on AC power
powercfg /change monitor-timeout-ac 0
Write-Host "[OK] Monitor timeout on AC: disabled"

# Disable hibernate
powercfg /hibernate off
Write-Host "[OK] Hibernate: disabled"

# Disable disk timeout on AC power
powercfg /change disk-timeout-ac 0
Write-Host "[OK] Disk timeout on AC: disabled"

Write-Host ""
Write-Host "Power settings applied successfully." -ForegroundColor Green
Write-Host "Verify with: powercfg /query" -ForegroundColor Yellow
