# setup_watchdog_task.ps1
# Registers the IFX relay watchdog as a Windows Scheduled Task.
# Run once as Administrator. Survives reboots.

$TASK_NAME = "IFX-RelayWatchdog"

schtasks /delete /tn $TASK_NAME /f 2>$null

schtasks /create `
    /tn  $TASK_NAME `
    /tr  "powershell.exe -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\mt5system\watchdog_relay.ps1" `
    /sc  minute `
    /mo  1 `
    /ru  SYSTEM `
    /f

Write-Host ""
Write-Host "Task '$TASK_NAME' registered - runs every 60s as SYSTEM."
Write-Host "Logs: C:\mt5system\logs\watchdog.log"
Write-Host ""
Write-Host "Commands:"
Write-Host "  Run now  : schtasks /run /tn $TASK_NAME"
Write-Host "  Remove   : schtasks /delete /tn $TASK_NAME /f"
Write-Host "  View log : Get-Content C:\mt5system\logs\watchdog.log -Tail 30 -Wait"