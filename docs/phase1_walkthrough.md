# IFX MT5 Runtime — Phase 1 Walkthrough

## What Was Built

All Phase 1 core runtime files are live at `C:\mt5-runtime\mt5-runtime-vps\`.

---

## Files Generated

| File                      | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `config/settings.json`    | All tunable constants (timeouts, retry limits, backoff, etc.) |
| `crypto_utils.py`         | AES-256-GCM decrypt/encrypt for MT5 passwords                 |
| `db_client.py`            | Supabase wrapper — all DB/RPC calls in one place              |
| `provision_terminal.py`   | Isolated portable MT5 folder per connection                   |
| `job_worker.py`           | Full idempotent trade execution loop with heartbeat           |
| `supervisor.py`           | Watchdog — spawns, monitors, restarts, flap-protects workers  |
| `setup_windows_power.ps1` | One-time: disables sleep/hibernate on VPS                     |
| `requirements.txt`        | Python dependencies                                           |
| `.env.example`            | Template for all required env vars                            |

---

## How They Connect

```
supervisor.py
  ├── polls Supabase every 10s (get_active_connections)
  ├── reads mt5_worker_heartbeats
  └── spawns → job_worker.py <connection_id>
                ├── provision_terminal.py (verify/create terminal folder)
                ├── crypto_utils.py (decrypt password)
                ├── mt5.initialize() + mt5.login()
                ├── heartbeat loop (db_client → upsert_heartbeat every 5s)
                └── job loop:
                      db_client.claim_trade_job()
                      → idempotency: DB check + MT5 comment check
                      → db_client.mark_trade_job_executing()
                      → mt5.order_send() with comment="IFX:{job_id}"
                      → db_client.complete_trade_job()
```

---

## Deployment Steps

```powershell
# 1. Run power settings (once, as Admin)
.\setup_windows_power.ps1

# 2. Install dependencies
pip install -r requirements.txt

# 3. Copy .env.example → .env and fill in values
copy .env.example .env

# 4. Generate master key (run once, store result in .env)
python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"

# 5. Run SQL migration — paste contents of master spec Section 8 RPCs into Supabase SQL editor

# 6. Start supervisor (test manually first)
python supervisor.py

# 7. Once stable → install as NSSM service (Phase 4)
```

---

## Key Design Decisions

| Decision                                       | Reason                                               |
| ---------------------------------------------- | ---------------------------------------------------- |
| Workers are child processes, not threads       | MT5 Python bindings are not thread-safe              |
| `for update skip locked` in claim RPC          | Prevents two workers claiming the same job           |
| Grace period (60s) before stale heartbeat kill | MT5 startup takes 20–40s on cold boot                |
| `del password` right after login               | Password cleared from memory immediately             |
| `os.abort()` crash hook                        | Simulates hard crash for idempotency acceptance test |
| WARN/ERROR only to DB events table             | Prevents event table bloat from info-level noise     |

---

## Acceptance Tests (Phase 1)

| #   | How to Run                                   | Pass Condition                                                           |
| --- | -------------------------------------------- | ------------------------------------------------------------------------ |
| T1  | Create 3 active connections in Supabase      | Supervisor spawns 3 workers within 10s                                   |
| T2  | `taskkill /PID <worker_pid> /F`              | Supervisor restarts within 20s                                           |
| T3  | Insert row into `trade_jobs` (status=queued) | Worker claims → executes → status=`success`, comment has `IFX:{job_id}`  |
| T4  | Set `IFX_CRASH_AFTER_ORDER=1`, run worker    | On restart: finds order by comment → marks `success`, no duplicate trade |

---

## Next: Phase 2

- `user_strategies` table + CRUD API
- AI evaluation cron + lot size engine
- `ai_trade_decisions` insert logic
- `trade_job` creation from validated AI decision
