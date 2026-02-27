# IFX AI Trading Portal — Master System Spec

> **Version:** 3.0 Final  
> **Date:** 2026-02-27  
> **Status:** Approved — Ready for Phased Development

---

## 0. What We Are Building

A **multi-tenant AI-driven trade execution platform**.

- Users log in, connect MT5, configure strategy parameters
- AI generates personalized trade decisions per user
- Trades execute automatically on each user's MT5 account
- **NOT** a signal group. **NOT** copy-trading. Every user's trades are independently generated.

---

## 1. System Architecture (4 Layers)

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Frontend Portal (Next.js)                 │
│  Login · Connect MT5 · Configure Strategy · View    │
└─────────────────────┬───────────────────────────────┘
                      │ HTTPS / Supabase
┌─────────────────────▼───────────────────────────────┐
│  Layer 2: Backend Control Layer (API / Supabase)    │
│  Store credentials · Strategy config · Create jobs  │
│  Enforce daily limits · Trigger AI cycles           │
└──────────┬────────────────────────┬─────────────────┘
           │                        │
┌──────────▼──────────┐  ┌──────────▼──────────────────┐
│ Layer 3: AI Engine  │  │ Layer 4: MT5 Runtime (VPS)  │
│ Market data input   │  │ Worker per connection        │
│ Per-user evaluation │  │ Claims job → executes trade  │
│ Outputs trade_job   │  │ Heartbeat · Idempotency      │
└─────────────────────┘  └─────────────────────────────┘
```

### Critical Rule

> **AI generates decisions. Workers only execute. Never mix strategy logic inside the worker.**

---

## 2. Layer Responsibilities

### Layer 1 — Frontend Portal

| Feature         | Details                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| Auth            | Google OAuth (existing)                                                    |
| MT5 Connection  | Enter credentials → encrypted + stored                                     |
| Strategy Config | Risk%, max trades/day, symbols, timeframe, RR, filters                     |
| Dashboard       | Account info, open trades, trade history, AI decision logs, runtime health |
| Realtime        | Live heartbeat status, job status updates                                  |

### Layer 2 — Backend Control Layer

| Responsibility              | Details                                           |
| --------------------------- | ------------------------------------------------- |
| Credential storage          | AES-256-GCM encrypted in Supabase                 |
| Strategy evaluation trigger | Cron every X min → call AI engine per active user |
| Job creation                | Insert validated `trade_job` rows                 |
| Risk pre-validation         | Daily limit, open trade limit, risk% check        |
| Audit trail                 | Log every AI decision to `ai_trade_decisions`     |
| Does NOT                    | Place trades directly — only creates jobs         |

### Layer 3 — AI Decision Engine

| Input                           | Output                         |
| ------------------------------- | ------------------------------ |
| Market data (OHLCV, indicators) | `symbol`                       |
| User strategy parameters        | `direction` (buy/sell)         |
| Risk profile                    | `entry_logic`                  |
| Account balance                 | `sl`, `tp`                     |
| Allowed symbols + filters       | `volume` (calculated per user) |

**Lot size formula (per user, deterministic):**

```
risk_amount = balance × (risk_percent / 100)
lot_size    = risk_amount / stop_loss_value
```

Each user gets a different lot size. Never reuse across users.

**Per evaluation cycle:**

1. Pull active user strategy
2. Pull account balance from last heartbeat / MT5
3. Run strategy logic on market data
4. Validate: daily limit not exceeded, open trade limit ok, risk valid
5. If valid → insert `trade_job` + `ai_trade_decision`

### Layer 4 — MT5 Runtime (VPS, Windows)

| Responsibility                 | Details                                                 |
| ------------------------------ | ------------------------------------------------------- |
| One worker per `connection_id` | Isolated portable MT5 terminal                          |
| Heartbeat                      | Upsert `mt5_worker_heartbeats` every 5s                 |
| Job claim                      | Atomic `claim_trade_job` RPC                            |
| Idempotency                    | Check DB + MT5 comment before placing order             |
| Execution                      | `mt5.order_send()` with `comment = "IFX:" + job_id`     |
| Result                         | Write back to `trade_jobs` via `complete_trade_job` RPC |
| Zero strategy logic            | Only validates risk constraints already set by backend  |

---

## 3. Database Schema

### Existing (verified fields needed)

**`mt5_user_connections`**

- `id`, `user_id`, `account_login`, `broker_server`
- `password_ciphertext_b64`, `password_nonce_b64`
- `is_active`, `status` enum, `last_seen_at`, `last_error`
- Test fields: `test_request_id`, `last_test_ok`, `last_test_at`, etc.

---

### New Tables

#### `user_strategies`

| Field                       | Type        | Notes                           |
| --------------------------- | ----------- | ------------------------------- |
| `id`                        | uuid PK     |                                 |
| `user_id`                   | uuid FK     |                                 |
| `connection_id`             | uuid FK     | links to MT5 account            |
| `is_active`                 | bool        |                                 |
| `risk_percent`              | numeric     | e.g. 1.5                        |
| `max_daily_trades`          | int         |                                 |
| `allowed_symbols`           | text[]      | e.g. `['EURUSD','XAUUSD']`      |
| `timeframe`                 | text        | e.g. `'H1'`                     |
| `rr_min`                    | numeric     | min risk:reward                 |
| `rr_max`                    | numeric     | max risk:reward                 |
| `filters_json`              | jsonb       | news/session/volatility filters |
| `last_evaluated_at`         | timestamptz |                                 |
| `created_at` / `updated_at` | timestamptz |                                 |

#### `ai_trade_decisions`

| Field              | Type             | Notes                        |
| ------------------ | ---------------- | ---------------------------- |
| `id`               | uuid PK          |                              |
| `user_id`          | uuid FK          |                              |
| `connection_id`    | uuid FK          |                              |
| `strategy_id`      | uuid FK          | snapshot at evaluation time  |
| `symbol`           | text             |                              |
| `direction`        | text             | buy/sell                     |
| `entry_price`      | numeric          |                              |
| `sl`               | numeric          |                              |
| `tp`               | numeric          |                              |
| `volume`           | numeric          | calculated per user          |
| `rr_actual`        | numeric          | calculated RR                |
| `reasoning`        | jsonb            | AI metadata, indicators used |
| `decision`         | text             | accepted/rejected            |
| `rejection_reason` | text             | if rejected                  |
| `trade_job_id`     | uuid FK nullable | set if job was created       |
| `created_at`       | timestamptz      |                              |

#### `trade_jobs` (as specified in MT5 runtime spec)

- `id`, `connection_id`, `symbol`, `side`, `volume`, `sl`, `tp`
- `comment` (must contain `job_id`)
- `idempotency_key` unique per connection
- `status` enum, `retry_count`, `claimed_by`, `claimed_at`
- `executed_at`, `result`, `error`, `error_code`

#### `mt5_worker_heartbeats` (as per runtime spec)

- `connection_id`, `pid`, `host`, `status`, `started_at`, `last_seen_at`
- `mt5_initialized`, `account_login`, `last_metrics`

#### `mt5_runtime_events` (WARN/ERROR only in DB)

- `connection_id`, `level`, `component`, `message`, `details`, `created_at`
- Auto-purge after 30 days

---

## 4. RPC Contracts

| RPC                                                   | Layer   | Purpose                                 |
| ----------------------------------------------------- | ------- | --------------------------------------- |
| `claim_trade_job(connection_id, claimed_by, timeout)` | Runtime | Atomic job claim + orphan recovery      |
| `mark_trade_job_executing(job_id)`                    | Runtime | Set status = executing                  |
| `complete_trade_job(job_id, status, result, error)`   | Runtime | Finalize job (guards success overwrite) |
| `retry_trade_job(job_id, error, error_code)`          | Runtime | Increment retry_count                   |
| `log_mt5_runtime_event(...)`                          | Runtime | Insert warn/error event                 |

> Backend (Layer 2) inserts `trade_jobs` directly via service role.  
> Runtime (Layer 4) only calls the RPCs above.

---

## 5. Idempotency (Exactly-Once Trades)

```
Before order_send():
  1. DB: job.status == 'success'? → skip
  2. MT5: open order with comment containing job_id? → skip
  3. Only place trade if both show not executed

When placing:
  request.comment = "IFX:" + job_id

After crash recovery:
  Find order by comment → mark job success (no duplicate)
```

---

## 6. Security Model

| Item             | Rule                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| Passwords        | AES-256-GCM, key in `.env` (Phase 1) → Windows Credential Manager (Phase 2) |
| Never log        | Plaintext passwords, decrypted credentials                                  |
| Service role key | On VPS only, locked-down, gitignored `.env`                                 |
| Phase 3          | Restrict to RPC-only key, RLS policies per runtime role                     |

---

## 7. Config Constants (`config/settings.json`)

```json
{
  "MT5_INIT_TIMEOUT_SEC": 30,
  "MT5_LOGIN_TIMEOUT_SEC": 15,
  "MT5_INIT_RETRIES": 3,
  "MT5_INIT_COOLDOWN_SEC": 300,
  "HEARTBEAT_INTERVAL_SEC": 5,
  "HEARTBEAT_STALE_SEC": 20,
  "SUPERVISOR_GRACE_SEC": 60,
  "SUPERVISOR_POLL_SEC": 10,
  "FLAP_MAX_RESTARTS": 5,
  "FLAP_WINDOW_SEC": 600,
  "CLAIM_TIMEOUT_SEC": 60,
  "MAX_RETRIES": 3,
  "BACKOFF_START_SEC": 5,
  "BACKOFF_MAX_SEC": 60,
  "EVENT_TTL_DAYS": 30,
  "AI_EVAL_INTERVAL_MIN": 5
}
```

---

## 8. Modular Architecture

```
C:\mt5system\                         ← project root
  main.py                             ← root launcher (python main.py supervisor|worker|scheduler)
  requirements.txt
  .env                                ← secrets (gitignored)
  config\settings.json

  runtime\                            ← MT5 execution layer (VPS)
    job_worker.py                     ← idempotent trade executor
    supervisor.py                     ← watchdog + flap protection
    provision_terminal.py             ← terminal isolation
    poller.py                         ← connection tester
    crypto_utils.py                   ← AES-256-GCM decrypt
    db_client.py                      ← all Supabase/RPC calls
    setup_windows_power.ps1

  ai_engine\                          ← AI decision layer
    decision_runner.py                ← orchestrates strategy → output
    eval_scheduler.py                 ← runs every X min per user
    strategies\
      base_strategy.py                ← abstract interface (must implement)
      choch_strategy.py               ← (add strategies here)
      breakout_strategy.py

  risk_engine\                        ← risk + lot size (independent)
    lot_calculator.py                 ← lot size + RR + daily limits

  job_queue\                          ← job creation (independent)
    job_creator.py                    ← validates + inserts trade_job

  monitoring\                         ← observability (future)

  docs\                               ← specs, migrations, walkthroughs
  logs\                               ← per-process log files
  terminals\<connection_id>\          ← isolated MT5 terminals
  .venv\
```

### Module Boundaries (enforced)

| Module        | Input                                      | Output                        | Must NOT touch            |
| ------------- | ------------------------------------------ | ----------------------------- | ------------------------- |
| `ai_engine`   | Market data + strategy config              | `TradeIdea`                   | MT5, DB, lot size         |
| `risk_engine` | `TradeIdea` + balance + broker constraints | `volume`, `rr`, `risk_amount` | MT5, DB, AI logic         |
| `job_queue`   | Validated trade + risk result              | `trade_job` row               | MT5, AI logic             |
| `runtime`     | `trade_job` rows                           | MT5 order + result            | Strategy logic, risk calc |

---

## 9. Deliverables (Phased)

### ✅ Phase 1 — Foundation (Core Runtime) — COMPLETE

| #   | Deliverable                                          | Layer   | Status                           |
| --- | ---------------------------------------------------- | ------- | -------------------------------- |
| 1.1 | SQL migration: all tables + RPCs                     | DB      | ✅ In spec — paste into Supabase |
| 1.2 | `crypto_utils.py` — AES-256-GCM decrypt              | Runtime | ✅ Done                          |
| 1.3 | `provision_terminal.py` — isolated terminal copy     | Runtime | ✅ Done                          |
| 1.4 | `db_client.py` — Supabase wrapper for all RPCs       | Runtime | ✅ Done                          |
| 1.5 | `job_worker.py` — idempotent loop + heartbeat        | Runtime | ✅ Done                          |
| 1.6 | `supervisor.py` — watchdog + grace + flap protection | Runtime | ✅ Done                          |

**Acceptance gate:** 3 connections → 3 workers → kill 1 → restarts in 20s

---

### 🟨 Phase 2 — Backend Control + AI Hook

| #   | Deliverable                                          | Layer        | Owner |
| --- | ---------------------------------------------------- | ------------ | ----- |
| 2.1 | `user_strategies` CRUD API                           | Backend      | Dev   |
| 2.2 | AI evaluation cron trigger (per active user)         | Backend      | Dev   |
| 2.3 | `ai_trade_decisions` insert + validation logic       | Backend / AI | Dev   |
| 2.4 | Lot size calculation engine (deterministic per user) | Backend      | Dev   |
| 2.5 | `trade_job` creation from validated AI decision      | Backend      | Dev   |
| 2.6 | Daily trade limit enforcement                        | Backend      | Dev   |

**Acceptance gate:** User strategy → AI decision → `trade_job` created → worker executes

---

### 🟩 Phase 3 — Frontend Portal

| #   | Deliverable                                  | Layer    | Owner |
| --- | -------------------------------------------- | -------- | ----- |
| 3.1 | Google OAuth login (existing)                | Frontend | Dev   |
| 3.2 | MT5 connection form + credential encryption  | Frontend | Dev   |
| 3.3 | Strategy configuration page                  | Frontend | Dev   |
| 3.4 | Dashboard: account info + open trades        | Frontend | Dev   |
| 3.5 | Trade history + AI decision log view         | Frontend | Dev   |
| 3.6 | Runtime health panel (heartbeat live status) | Frontend | Dev   |
| 3.7 | Realtime updates (Supabase subscriptions)    | Frontend | Dev   |

**Acceptance gate:** Full end-to-end — user configures strategy in browser → trade executes on MT5

---

### 🟥 Phase 4 — Hardening + Production

| #   | Deliverable                                                        | Layer      | Owner |
| --- | ------------------------------------------------------------------ | ---------- | ----- |
| 4.1 | `poller.py` — shared test terminal + file lock mutex               | Runtime    | Dev   |
| 4.2 | Popup/block detection → terminal restart trigger                   | Runtime    | Dev   |
| 4.3 | NSSM service registration (`IFX_MT5_Supervisor`, `IFX_MT5_Poller`) | Deployment | Dev   |
| 4.4 | `setup_windows_power.ps1` one-time run                             | Deployment | Dev   |
| 4.5 | WARN/ERROR event logging to DB + 30-day purge                      | Runtime    | Dev   |
| 4.6 | Replace service role with restricted RPC key                       | Security   | Dev   |
| 4.7 | Windows Credential Manager for master decrypt key                  | Security   | Dev   |
| 4.8 | RLS policies per runtime role                                      | Security   | Dev   |

---

## 10. Acceptance Tests (Full System)

| #   | Test                               | Pass Condition                                           |
| --- | ---------------------------------- | -------------------------------------------------------- |
| T1  | 3 connections active               | 3 isolated workers running                               |
| T2  | Kill worker PID                    | Restarts within 20s                                      |
| T3  | Insert trade_job manually          | Claimed → executed → `success`, comment has `job_id`     |
| T4  | `IFX_CRASH_AFTER_ORDER=1` crash    | Restart finds order by comment → `success`, no duplicate |
| T5  | Portal connection test             | `last_test_ok` updates, worker terminal untouched        |
| T6  | User sets strategy → AI cycle runs | `ai_trade_decision` created, `trade_job` inserted        |
| T7  | 2 users, different risk%           | Different lot sizes calculated, independent jobs         |
| T8  | Daily limit reached                | AI does not create new jobs, decision marked `rejected`  |

---

## 11. Current Status

| Phase                     | Status                                     |
| ------------------------- | ------------------------------------------ |
| Phase 1 — Core Runtime    | ✅ Complete — all files in `C:\mt5system\` |
| Phase 2 — AI Hook         | 🟨 In progress                             |
| Phase 3 — Frontend Portal | ⬜ Pending                                 |
| Phase 4 — Hardening       | ⬜ Pending                                 |
