Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -Path $Root

Write-Host ''
Write-Host 'start_runtime_headless.ps1 is deprecated.' -ForegroundColor Yellow
Write-Host 'It no longer starts relay, supervisor, scheduler, or workers.' -ForegroundColor Yellow
Write-Host 'Use d:\mt5new\.venv\Scripts\python.exe .\runtime\terminal_manager.py run for the EA-first architecture.' -ForegroundColor Yellow
exit 1
