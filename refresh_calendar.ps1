# ============================================================
# IFX MT5 — Economic Calendar Refresh
# Populates Supabase economic_events table from all providers.
# Run manually or via Task Scheduler (recommended: weekly Sun 18:00).
#
# Usage:
#   .\refresh_calendar.ps1              # next 14 days
#   .\refresh_calendar.ps1 -Days 30     # next 30 days
#   .\refresh_calendar.ps1 -DryRun      # local SQLite only
# ============================================================

param(
    [int]$Days = 14,
    [switch]$DryRun
)

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python  = Join-Path $Root ".venv\Scripts\python.exe"
$Script  = Join-Path $Root "runtime\news_refresh.py"

if (-not (Test-Path $Python)) {
    Write-Error "Virtual environment not found at $Python. Run setup first."
    exit 1
}

$Args = @("--days", $Days)
if ($DryRun) { $Args += "--dry-run" }

Write-Host "==> IFX Economic Calendar Refresh  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" -ForegroundColor Cyan
Write-Host "    Python : $Python" -ForegroundColor DarkGray
Write-Host "    Days   : $Days" -ForegroundColor DarkGray
Write-Host "    Dry-run: $($DryRun.IsPresent)" -ForegroundColor DarkGray
Write-Host ""

& $Python $Script @Args
$ec = $LASTEXITCODE

if ($ec -eq 0) {
    Write-Host "`n==> Refresh complete." -ForegroundColor Green
} else {
    Write-Host "`n==> Refresh FAILED (exit $ec)." -ForegroundColor Red
}
exit $ec
