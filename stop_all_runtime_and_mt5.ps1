Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

function Stop-Mt5ProcessGracefully {
    param(
        [Parameter(Mandatory = $true)]
        $CimProcess,

        [int]$TimeoutSeconds = 15
    )

    try {
        $process = Get-Process -Id $CimProcess.ProcessId -ErrorAction Stop
    } catch {
        return $true
    }

    try {
        if ($process.MainWindowHandle -ne 0) {
            $null = $process.CloseMainWindow()
        } else {
            Stop-Process -Id $process.Id -ErrorAction Stop
        }

        Wait-Process -Id $process.Id -Timeout $TimeoutSeconds -ErrorAction Stop
        return $true
    } catch {
        Write-Warning ("graceful terminal stop failed pid={0}: {1}" -f $process.Id, $_.Exception.Message)
    }

    return $false
}

Write-Host 'Emergency stop only.' -ForegroundColor Yellow
Write-Host 'This script is not part of normal startup in Railway-only mode.' -ForegroundColor Yellow
Write-Host ''

Write-Host '[1/4] Stopping runtime Python processes...' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object {
        $_.CommandLine -match 'main\.py supervisor|main\.py scheduler|runtime\\price_relay\.py|runtime\\job_worker\.py'
    } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            Write-Host ("  stopped python pid={0}" -f $_.ProcessId) -ForegroundColor DarkGray
        } catch {
            Write-Warning ("python stop failed pid={0}: {1}" -f $_.ProcessId, $_.Exception.Message)
        }
    }

Write-Host '[2/4] Stopping runtime launcher PowerShell windows...' -ForegroundColor Cyan
$currentPid = $PID
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object {
        $_.ProcessId -ne $currentPid -and
        $_.CommandLine -match 'main\.py supervisor|main\.py scheduler|runtime\\price_relay\.py|runtime\\job_worker\.py|restart_runtime\.ps1|start_runtime_headless\.ps1'
    } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
            Write-Host ("  stopped powershell pid={0}" -f $_.ProcessId) -ForegroundColor DarkGray
        } catch {
            Write-Warning ("powershell stop failed pid={0}: {1}" -f $_.ProcessId, $_.Exception.Message)
        }
    }

Write-Host '[3/4] Stopping MT5 terminals (graceful first)...' -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
    Where-Object {
        ($_.ExecutablePath -like 'C:\mt5system\terminals\*') -or
        ($_.ExecutablePath -like 'C:\Program Files\MetaTrader 5 EXNESS\*')
    } |
    ForEach-Object {
        try {
            if (Stop-Mt5ProcessGracefully -CimProcess $_) {
                Write-Host ("  stopped terminal64 pid={0} gracefully" -f $_.ProcessId) -ForegroundColor DarkGray
            } else {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
                Write-Warning ("terminal pid={0} required force stop; MT5 may not persist settings" -f $_.ProcessId)
            }
        } catch {
            Write-Warning ("terminal stop failed pid={0}: {1}" -f $_.ProcessId, $_.Exception.Message)
        }
    }

Write-Host '[4/4] Releasing relay port 8082...' -ForegroundColor Cyan
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        try {
            Stop-Process -Id $_ -Force -ErrorAction Stop
            Write-Host ("  released port via pid={0}" -f $_) -ForegroundColor DarkGray
        } catch {
            Write-Warning ("port release failed pid={0}: {1}" -f $_, $_.Exception.Message)
        }
    }

Write-Host 'Stop complete.' -ForegroundColor Green
