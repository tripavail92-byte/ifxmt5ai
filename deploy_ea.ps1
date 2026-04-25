#Requires -Version 5.1
param(
    [switch]$CompileOnly,
    [switch]$DeployOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$EA_NAME        = "IFX_Railway_Bridge_v1"
$SOURCE_MQ5     = "d:\mt5new\$EA_NAME.mq5"
$TERMINALS_ROOT = "C:\mt5system\terminals"
$COMPILE_TERMINAL = "9e9be7f0-fd3e-44fa-84be-3a6f2394ad40"
$DEPLOY_TERMINALS = @(
    "9e9be7f0-fd3e-44fa-84be-3a6f2394ad40",
    "c9fc4e21-f284-4c86-999f-ddedd5649734"
)

function Write-Step  { param($msg) Write-Host "`n[STEP] $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Info  { param($msg) Write-Host "        $msg"  -ForegroundColor Gray }

function ExpertsIFX($guid) { return Join-Path $TERMINALS_ROOT "$guid\MQL5\Experts\IFX" }
function TerminalExe($guid) { return Join-Path $TERMINALS_ROOT "$guid\terminal64.exe" }
function StartupIni($guid)  { return Join-Path $TERMINALS_ROOT "$guid\startup.ini" }

$compiledEx5 = $null

if (-not $DeployOnly) {
    Write-Step "Compile: $EA_NAME"
    if (-not (Test-Path $SOURCE_MQ5)) { Write-Fail "Source not found: $SOURCE_MQ5"; exit 1 }

    $compileDir = ExpertsIFX $COMPILE_TERMINAL
    $targetMq5  = Join-Path $compileDir "$EA_NAME.mq5"
    $targetEx5  = Join-Path $compileDir "$EA_NAME.ex5"
    $logFile    = Join-Path $compileDir "$EA_NAME.log"
    $metaEditor = Join-Path $TERMINALS_ROOT "$COMPILE_TERMINAL\MetaEditor64.exe"

    if (-not (Test-Path $metaEditor)) { Write-Fail "MetaEditor not found: $metaEditor"; exit 1 }
    if (-not (Test-Path $compileDir)) { New-Item -ItemType Directory -Path $compileDir -Force | Out-Null }

    Write-Info "Copying source -> $targetMq5"
    Copy-Item -Path $SOURCE_MQ5 -Destination $targetMq5 -Force

    Write-Info "Running MetaEditor64 /compile ..."
    $proc = Start-Process -FilePath $metaEditor `
        -ArgumentList "/portable", "/compile:`"$targetMq5`"", "/log:`"$logFile`"" `
        -WorkingDirectory (Join-Path $TERMINALS_ROOT $COMPILE_TERMINAL) `
        -Wait -PassThru -NoNewWindow
    Write-Info "MetaEditor exit code: $($proc.ExitCode)"

    if (Test-Path $logFile) {
        $logContent = Get-Content $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        Write-Info "--- compile log ---"
        ($logContent -split "`n") | ForEach-Object { Write-Info $_ }
        Write-Info "--- end log ---"
        if ($logContent -match "(\d+) error") {
            $errorCount = [int]$Matches[1]
            if ($errorCount -gt 0) {
                Write-Fail "Compilation FAILED: $errorCount error(s). Aborting."
                exit 1
            }
        }
    }

    if (-not (Test-Path $targetEx5)) {
        Write-Fail "No ex5 produced. Check log above."
        exit 1
    }

    $compiledEx5 = $targetEx5
    Write-Ok "Compiled OK -> $compiledEx5"

    if ($CompileOnly) { Write-Ok "CompileOnly: done."; exit 0 }
}
else {
    $compiledEx5 = Join-Path (ExpertsIFX $COMPILE_TERMINAL) "$EA_NAME.ex5"
    if (-not (Test-Path $compiledEx5)) { Write-Fail "DeployOnly: no ex5 at $compiledEx5"; exit 1 }
    Write-Warn "DeployOnly mode: using existing $compiledEx5"
}

Write-Step "Deploy ex5 to all terminals"
foreach ($guid in $DEPLOY_TERMINALS) {
    $dir  = ExpertsIFX $guid
    $dest = Join-Path $dir "$EA_NAME.ex5"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ($compiledEx5 -ne $dest) { if ($compiledEx5 -ne $dest) { Copy-Item -Path $compiledEx5 -Destination $dest -Force } else { Write-Info "Source = dest, skip copy" } } else { Write-Info "Source = dest, skip copy" }
    Write-Ok "Copied -> $dest"
}

Write-Step "Stop running MT5 terminals"
foreach ($guid in $DEPLOY_TERMINALS) {
    $exePath = TerminalExe $guid
    $procs = Get-Process terminal64 -ErrorAction SilentlyContinue |
             Where-Object { $_.Path -eq $exePath }
    if ($procs) {
        foreach ($p in $procs) {
            Write-Info "Stopping PID $($p.Id) ($guid)"
            $p | Stop-Process -Force
        }
        Write-Ok "Stopped -> $guid"
    }
    else {
        Write-Warn "Not running -> $guid (will start fresh)"
    }
}

Write-Info "Waiting 3 seconds for processes to exit ..."
Start-Sleep -Seconds 3

Write-Step "Restart terminals with startup.ini"
foreach ($guid in $DEPLOY_TERMINALS) {
    $exe     = TerminalExe $guid
    $ini     = StartupIni $guid
    $workDir = Join-Path $TERMINALS_ROOT $guid
    if (-not (Test-Path $exe))  { Write-Warn "terminal64.exe not found for $guid - skip"; continue }
    if (-not (Test-Path $ini))  { Write-Warn "startup.ini not found for $guid - skip"; continue }
    Write-Info "Starting $exe"
    Start-Process -FilePath $exe -ArgumentList "/portable", "/config:`"$ini`"" -WorkingDirectory $workDir
    Write-Ok "Started -> $guid"
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " EA DEPLOY COMPLETE: $EA_NAME" -ForegroundColor Green
Write-Host " Both terminals restarting with new EA build." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green