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

Do not use these deprecated helpers to start anything. They were moved to `archive/legacy-local-runtime/root-deprecated/`:
- `restart_runtime.ps1`
- `start_runtime_headless.ps1`
- `restart_all_services.ps1`
- `watchdog_relay.ps1`
- `setup_watchdog_task.ps1`

Additional retired launchers remain in `archive/legacy-local-runtime/` for historical reference.

## MT5 Requirements

In MT5, open Tools -> Options -> Expert Advisors.

Allow WebRequest for:
- `https://ifx-mt5-portal-production.up.railway.app`

If MT5 shows `err=4014`, treat it as a terminal-side WebRequest allow-list problem, not a missing local relay.

## MT5 Persistence Rules

Treat each portable terminal folder as persistent state, not disposable cache.

- Launch every managed instance with `/portable` only.
- Configure the WebRequest allow-list manually in one clean master terminal, close MT5 normally, and use that folder as `MT5_TEMPLATE_DIR`.
- Reuse the same per-connection terminal directory after provisioning; do not silently rebuild an existing instance during normal operation.
- Do not rely on `.ini` edits or guessed config keys to recreate the WebRequest allow-list.
- Do not force-kill MT5 during normal lifecycle operations; MT5 persists settings only after a clean shutdown.

Operational implication:

- `MT5_TEMPLATE_DIR` should point to a manually verified portable master whose WebRequest allow-list still exists after a clean restart.
- Existing instance folders are now protected from silent reprovision unless `MT5_ALLOW_EXISTING_INSTANCE_REPROVISION=1` is set explicitly.

## Build Real Master

Do not reuse `final-clean-manual` as a template.

Use a dedicated clean master folder instead:

```powershell
.\setup_mt5_master.ps1
```

That script prepares `C:\MT5_MASTER` from a clean MT5 installation and launches it with `/portable`.

Manual validation sequence inside MT5:

1. In MT5, use `File -> Open Data Folder` and confirm it opens `C:\MT5_MASTER`.
2. Open `Tools -> Options -> Expert Advisors`.
3. Enable algo trading as needed and add `https://ifx-mt5-portal-production.up.railway.app` to the WebRequest allow-list.
4. After clicking `OK`, wait 5-10 seconds without closing MT5.
5. Close MT5 using `File -> Exit`.
6. Reopen `C:\MT5_MASTER\terminal64.exe /portable` and confirm the URL is still present.
7. Attach a test EA and confirm WebRequest succeeds without `err=4014`.

Only after that passes should `.env` set `MT5_TEMPLATE_DIR=C:\MT5_MASTER`.
