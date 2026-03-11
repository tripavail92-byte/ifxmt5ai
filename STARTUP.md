# IFX MT5 Startup and Restart Runbook

This runbook is the standard way to start or restart the system safely on Windows.
Use this exactly to avoid duplicate Python processes, relay conflicts, and "connecting" UI states.

## Scope

Components covered:
- MT5 EA (`IFX_PriceBridge_v3.mq5`)
- Local relay (`runtime/price_relay.py`) on `127.0.0.1:8082`
- Runtime supervisor (`main.py supervisor`)

## Required Preconditions

1. MT5 WebRequest allow-list includes:
- `http://127.0.0.1:8082`

2. `.env` exists at repo root (`C:\mt5system\.env`) with valid keys:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MT5_CREDENTIALS_MASTER_KEY_B64`
- `RELAY_SECRET`
- `RAILWAY_INGEST_URL` (production ingest URL when using Railway UI)
- `RAILWAY_RELAY_TOKEN` (if your ingest endpoint requires auth)
- Optional: `RUNTIME_ALERT_WEBHOOK_URL` (Slack/Teams/Discord compatible webhook for audit failures)
- Optional: `RUNTIME_ALERT_COOLDOWN_SEC` (default `900`)

3. Always run with venv Python:
- `C:\mt5system\.venv\Scripts\python.exe`

## Create 3 Supabase Login Users

This creates three Supabase Auth users (auto-confirmed) so you can log in:

- `user1@ifxsystem.com`
- `user2@ifxsystem.com`
- `user3@ifxsystem.com`

Run (interactive password prompt):

```powershell
C:/mt5system/.venv/Scripts/python.exe create_supabase_users.py
```

Or set the password non-interactively:

```powershell
C:/mt5system/.venv/Scripts/python.exe create_supabase_users.py --password "YourPassword"
```

## Standard Restart (Authoritative Procedure)

Open **one PowerShell** at `C:\mt5system` and run:

```powershell
# 1) Stop old runtime processes (safe cleanup)
$targets = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'main\.py supervisor|runtime\\price_relay\.py|runtime\\job_worker\.py' }
$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 2) Verify no local relay is still listening
$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }

# 3) Start relay (Terminal A)
C:/mt5system/.venv/Scripts/python.exe runtime/price_relay.py
```

Open **second PowerShell** at `C:\mt5system` and run:

```powershell
# 4) Start supervisor (Terminal B)
C:/mt5system/.venv/Scripts/python.exe main.py supervisor
```

Notes:
- Keep relay and supervisor in separate terminals.
- Do not start multiple supervisor instances.
- Do not mix system Python and venv Python.

## Health Verification (After Startup)

Run these checks from a third PowerShell:

```powershell
# Relay health should return JSON
Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8082/health | Select-Object -ExpandProperty Content

# Confirm single relay and supervisor process
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'runtime\\price_relay\.py|main\.py supervisor' } |
  Select-Object ProcessId, CommandLine

# Confirm relay port bound once
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8082 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess

# Production audit (recommended)
C:/mt5system/.venv/Scripts/python.exe runtime/runtime_audit.py
```

Expected:
- `/health` responds with uptime JSON.
- Exactly 1 relay process and 1 supervisor process.
- Exactly 1 listener on `127.0.0.1:8082`.
- `runtime_audit.py` returns exit code 0.

For production use, schedule `runtime_audit.py` every 1 minute and alert on any non-zero exit code.
If `RUNTIME_ALERT_WEBHOOK_URL` is set, the audit also sends deduplicated failure/recovery notifications automatically.

## MT5 EA Runtime Checks

In MT5 Experts log, verify:
- EA started successfully.
- No repeated `HTTP -1 (WebRequest failed)` errors.
- If `HTTP -1` appears:
1. Recheck MT5 allow-list (`http://127.0.0.1:8082`).
2. Confirm relay is healthy via `/health`.
3. Confirm no stale process owns port 8082.

## If UI Is Stuck on "Connecting"

1. Check relay is up (`/health`).
2. Check relay logs:
- `runtime/logs/price_relay.log`
3. Check supervisor logs:
- `runtime/logs/supervisor.log`
4. Ensure `RAILWAY_INGEST_URL` points to the same environment as the UI you are viewing.

## If Historical Candles Are Missing

Symptoms:
- Chart shows only 1 to 3 recent candles after restart.

Checks:
1. In MT5 Experts log, look for `Historical bulk pushed`.
2. In relay log (`runtime/logs/price_relay.log`), confirm `/historical-bulk` is being received after restart.

Recovery:
1. Keep relay running and healthy.
2. Reinitialize EA once (remove and attach EA again on chart) to trigger history seed.
3. Wait one timer cycle (about 10 seconds) for health check and auto re-seed.

Note:
- EA now auto re-pushes history when relay becomes reachable after startup, even if initial push failed.

## Fast Recovery (When Unsure)

Run full cleanup, then restart in order:
1. Kill runtime Python processes.
2. Ensure port 8082 is free.
3. Start relay.
4. Start supervisor.
5. Re-attach/confirm EA on MT5 chart.

## Operational Rules (Do Not Break)

- Never run `python` from system install for runtime services.
- Never launch a second supervisor without stopping the first.
- Never run EA directly to Railway; EA must post to local relay.
- Always verify `/health` before debugging frontend symptoms.
- Always keep relay and supervisor running under OS-managed restart policy (Task Scheduler, NSSM, or Windows Service wrapper), not manual terminals only.

## Log Paths

- Relay: `runtime/logs/price_relay.log`
- Supervisor: `runtime/logs/supervisor.log`
- Worker logs: `runtime/logs/worker_*.log`
