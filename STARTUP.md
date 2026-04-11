# IFX Railway-Only Runbook

This is the canonical operator path for this workspace.

## Live Architecture

Only these components are part of normal operation:
- public Railway control plane at `https://ifx-mt5-portal-production.up.railway.app`
- public Railway relay at `https://ifx-mt5-portal-production.up.railway.app/api/mt5`
- local `runtime/terminal_manager.py` process
- portable MT5 terminals under `C:\mt5system\terminals`
- EA artifact configured by `IFX_EA_SOURCE_PATH`

The old local runtime stack is not part of the live path:
- no `runtime/price_relay.py`
- no `main.py supervisor`
- no `main.py scheduler`
- no `runtime/job_worker.py`
- no local relay on `127.0.0.1:8082`
- no cloudflared tunnel

## One Truth Check

Use this as the single health check:

```powershell
.\check_runtime.ps1
```

It reports only the live Railway-era state:
- configured control-plane URL
- configured relay URL
- configured EA artifact path
- control-plane terminal-host heartbeat state
- managed MT5 terminal bootstrap state
- Railway relay health
- any deprecated local runtime processes still hanging around

Exit codes:
- `0` = healthy
- `1` = warning
- `2` = critical

## Normal Local Actions

Start the terminal manager:

```powershell
d:\mt5new\.venv\Scripts\python.exe .\runtime\terminal_manager.py run
```

Emergency stop for local MT5 terminals and old runtime leftovers:

```powershell
.\stop_all_runtime_and_mt5.ps1
```

Do not use these deprecated helpers to start anything:
- `restart_runtime.ps1`
- `start_runtime_headless.ps1`
- `restart_all_services.ps1`

Additional retired launchers were moved into `archive/legacy-local-runtime/`.

## MT5 Requirements

In MT5, open Tools -> Options -> Expert Advisors.

Allow WebRequest for:
- `https://ifx-mt5-portal-production.up.railway.app`

If MT5 shows `err=4014`, treat it as a terminal-side WebRequest allow-list problem, not a missing local relay.
