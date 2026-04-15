Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$MasterDir = 'C:\MT5_MASTER'
$TerminalExe = Join-Path $MasterDir 'terminal64.exe'
$PortableMarker = Join-Path $MasterDir 'portable'
$Today = Get-Date -Format 'yyyyMMdd'
$ExpertLog = Join-Path $MasterDir ('MQL5\Logs\' + $Today + '.log')
$TerminalLog = Join-Path $MasterDir ('Logs\' + $Today + '.log')

Write-Host 'MT5 master validation' -ForegroundColor Cyan
Write-Host ('Master dir: ' + $MasterDir) -ForegroundColor Cyan
Write-Host ''

$checks = @(
    [pscustomobject]@{ Name = 'Master folder exists'; Ok = (Test-Path $MasterDir) },
    [pscustomobject]@{ Name = 'terminal64.exe exists'; Ok = (Test-Path $TerminalExe) },
    [pscustomobject]@{ Name = 'portable marker exists'; Ok = (Test-Path $PortableMarker) }
)

$checks | Format-Table -AutoSize | Out-String | Write-Host

if (Test-Path $ExpertLog) {
    Write-Host 'Recent expert log warnings/errors:' -ForegroundColor Yellow
    Get-Content $ExpertLog -Encoding Unicode |
        Select-String -Pattern '4014|WebRequest|HEARTBEAT|POST /|loaded successfully' -CaseSensitive:$false |
        Select-Object -Last 40 |
        ForEach-Object { $_.Line } |
        Out-String |
        Write-Host
} else {
    Write-Host ('Expert log not found for today: ' + $ExpertLog) -ForegroundColor Yellow
}

if (Test-Path $TerminalLog) {
    Write-Host 'Recent terminal log lines:' -ForegroundColor Yellow
    Get-Content $TerminalLog -Encoding Unicode |
        Select-String -Pattern 'expert|loaded successfully|error|failed|WebRequest' -CaseSensitive:$false |
        Select-Object -Last 40 |
        ForEach-Object { $_.Line } |
        Out-String |
        Write-Host
}

Write-Host 'Manual acceptance checklist:' -ForegroundColor Green
Write-Host '1. Open C:\MT5_MASTER\terminal64.exe with /portable' -ForegroundColor Green
Write-Host '2. File -> Open Data Folder opens C:\MT5_MASTER' -ForegroundColor Green
Write-Host '3. Tools -> Options -> Expert Advisors still shows https://ifx-mt5-portal-production.up.railway.app' -ForegroundColor Green
Write-Host '4. A test EA can call WebRequest without err=4014' -ForegroundColor Green
Write-Host '5. Only after that should .env set MT5_TEMPLATE_DIR=C:\MT5_MASTER' -ForegroundColor Green
