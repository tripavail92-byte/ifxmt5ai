Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$MasterDir = 'C:\MT5_MASTER'
$PreferredSource = 'C:\Program Files\MetaTrader 5 EXNESS'
$FallbackSource = 'C:\Program Files\MetaTrader 5'

function Resolve-SourceDir {
    foreach ($candidate in @($PreferredSource, $FallbackSource)) {
        if ((Test-Path $candidate) -and (Test-Path (Join-Path $candidate 'terminal64.exe'))) {
            return $candidate
        }
    }

    throw 'No MT5 base installation with terminal64.exe was found.'
}

$sourceDir = Resolve-SourceDir
$terminalExe = Join-Path $MasterDir 'terminal64.exe'

Write-Host ('Using MT5 source: ' + $sourceDir) -ForegroundColor Cyan
Write-Host ('Target master: ' + $MasterDir) -ForegroundColor Cyan

if (-not (Test-Path $MasterDir)) {
    New-Item -ItemType Directory -Path $MasterDir -Force | Out-Null
}

if (-not (Test-Path $terminalExe)) {
    Write-Host 'Copying clean MT5 base into C:\MT5_MASTER ...' -ForegroundColor Yellow
    $null = robocopy $sourceDir $MasterDir /MIR /NFL /NDL /NJH /NJS /NP
    $exitCode = $LASTEXITCODE
    if ($exitCode -gt 7) {
        throw ('robocopy failed with exit code ' + $exitCode)
    }
} else {
    Write-Host 'C:\MT5_MASTER already exists; reusing current contents.' -ForegroundColor Yellow
}

New-Item -ItemType File -Path (Join-Path $MasterDir 'portable') -Force | Out-Null

Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
    Where-Object { $_.ExecutablePath -eq $terminalExe } |
    ForEach-Object {
        try {
            $proc = Get-Process -Id $_.ProcessId -ErrorAction Stop
            if ($proc.MainWindowHandle -ne 0) {
                $null = $proc.CloseMainWindow()
                Wait-Process -Id $proc.Id -Timeout 15 -ErrorAction SilentlyContinue
            }
        } catch {
        }
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }

Start-Process -FilePath $terminalExe -ArgumentList '/portable' -WorkingDirectory $MasterDir

Write-Host ''
Write-Host 'MT5 master launched. Complete these manual steps before using it as a template:' -ForegroundColor Green
Write-Host '1. File -> Open Data Folder must open C:\MT5_MASTER' -ForegroundColor Green
Write-Host '2. Tools -> Options -> Expert Advisors' -ForegroundColor Green
Write-Host '3. Enable algo trading as needed and add https://ifx-mt5-portal-production.up.railway.app' -ForegroundColor Green
Write-Host '4. Click OK, wait 5-10 seconds, then close via File -> Exit' -ForegroundColor Green
Write-Host '5. Reopen C:\MT5_MASTER\terminal64.exe /portable and verify the URL persists' -ForegroundColor Green
Write-Host '6. Run .\validate_mt5_master.ps1 and do not set MT5_TEMPLATE_DIR until it passes manually' -ForegroundColor Green
