# IFX MT5 Runtime — Phase 1 Task Checklist

## Phase 1 — Core Runtime Files

- [x] `config/settings.json` — all tunable constants
- [x] `crypto_utils.py` — AES-256-GCM decrypt
- [x] `db_client.py` — Supabase wrapper for all RPCs
- [x] `provision_terminal.py` — isolated terminal copy + portable mode
- [x] `job_worker.py` — idempotent trade loop + heartbeat + backoff
- [x] `supervisor.py` — watchdog + grace period + flap protection
- [x] `setup_windows_power.ps1` — one-time power settings
- [x] `requirements.txt` + `.env.example`
- [ ] SQL migration file (tables + RPCs) — already in master spec, needs Supabase paste

## Phase 2 — Backend Control + AI Hook

- [ ] `user_strategies` CRUD API
- [ ] AI evaluation cron trigger
- [ ] `ai_trade_decisions` schema + insert logic
- [ ] Lot size calculation engine
- [ ] `trade_job` creation from validated AI decision
- [ ] Daily trade limit enforcement

## Phase 3 — Frontend Portal

- [ ] Strategy configuration page
- [ ] Dashboard: heartbeat live status
- [ ] Trade history + AI decision log view
- [ ] Realtime updates

## Phase 4 — Hardening

- [ ] `poller.py`
- [ ] NSSM service registration
- [ ] Restricted RPC key (replace service role)
- [ ] Windows Credential Manager for master key
