Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

$relaySourceConnId = Get-Content (Join-Path $Root '.env') -ErrorAction SilentlyContinue |
    ForEach-Object {
        if ($_ -match '^\s*RELAY_SOURCE_CONNECTION_ID\s*=\s*(.+?)\s*$') {
            $matches[1].Trim()
        }
    } |
    Select-Object -First 1

if (-not $relaySourceConnId) {
    $relaySourceConnId = 'a2baa968-f0b3-49aa-892d-5df0e1e1249f'
}

$TerminalDir = Join-Path $Root ("terminals\{0}" -f $relaySourceConnId)
$TerminalExe = Join-Path $TerminalDir 'terminal64.exe'
$StartupIni = Join-Path $TerminalDir 'startup.ini'
$InstalledExnessExe = 'C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe'

if (-not (Test-Path $TerminalExe)) {
    throw "Exness MT5 terminal not found for relay source connection ${relaySourceConnId}: $TerminalExe"
}

Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
    Where-Object {
        $_.ExecutablePath -eq $TerminalExe -or $_.ExecutablePath -eq 'C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe'
    } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
        } catch {
        }
    }

Start-Sleep -Seconds 2

function Test-TerminalRunning {
    param([string[]]$CandidatePaths)

    $running = Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
        Where-Object { $CandidatePaths -contains $_.ExecutablePath }
    return @($running).Count -gt 0
}

if (Test-Path $StartupIni) {
    Start-Process -FilePath $TerminalExe -WorkingDirectory $TerminalDir -ArgumentList '/portable',"/config:$StartupIni" | Out-Null
    Start-Sleep -Seconds 8
}

if (-not (Test-TerminalRunning -CandidatePaths @($TerminalExe, $InstalledExnessExe))) {
    Start-Process -FilePath $TerminalExe -WorkingDirectory $TerminalDir -ArgumentList '/portable' | Out-Null
    Start-Sleep -Seconds 8
}

if (-not (Test-TerminalRunning -CandidatePaths @($TerminalExe, $InstalledExnessExe)) -and (Test-Path $InstalledExnessExe)) {
    Start-Process -FilePath $InstalledExnessExe -WorkingDirectory (Split-Path -Parent $InstalledExnessExe) | Out-Null
    Start-Sleep -Seconds 8
}

if (-not (Test-TerminalRunning -CandidatePaths @($TerminalExe, $InstalledExnessExe))) {
    throw 'Exness MT5 did not stay running after launch attempts.'
}

Write-Host ("Exness MT5 launched for connection {0}." -f $relaySourceConnId) -ForegroundColor Green
