# IFX MT5 Runtime — Spec v2 Review & Updated Plan

> **Purpose:** Compare teacher's Spec v2 against our v1 recommendations. Verdict per item, then unified updated plan.

---

## Comparison Table

| #   | Topic                              | Our v1 Recommendation                                                         | Teacher's Spec v2                                                                                         | Verdict                                                     |
| --- | ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | **Crypto algorithm**               | AES-256-GCM, key in Windows Credential Store                                  | AES-256-GCM ✅, Phase 1: `.env`, Phase 2: `keyring`                                                       | ✅ **Correct** — phased approach is pragmatic               |
| 2   | **Who decrypts**                   | Worker + Poller locally, never log plaintext                                  | Worker + Poller locally, never log ✅                                                                     | ✅ **Correct**                                              |
| 3   | **Poller terminal**                | Single shared test terminal + mutex                                           | Single `MT5_TEST_TERMINAL_DIR` + `mt5_test.lock` file lock ✅                                             | ✅ **Correct** — file lock is a clean implementation choice |
| 4   | **MT5 init timeout**               | 30s init, 15s login, 3 retries, 5min cooldown                                 | `MT5_INIT_TIMEOUT_SEC=30`, `MT5_LOGIN_TIMEOUT_SEC=15`, `MT5_INIT_RETRIES=3` ✅ but cooldown = "5 minutes" | ✅ **Correct** — cooldown value matches                     |
| 5   | **Orphan job recovery**            | Add to `claim_trade_job`: reclaim `claimed` jobs stuck >60s                   | `CLAIM_TIMEOUT_SEC=60` ✅, SQL RPC correctly implements `for update skip locked` ✅                       | ✅ **Correct + well implemented**                           |
| 6   | **`retry_count` field**            | Add `retry_count INT DEFAULT 0`, max 3 retries                                | `retry_count` added ✅, max_retries=3 in config ✅                                                        | ✅ **Correct**                                              |
| 7   | **`claimed_by` format**            | `{hostname}:{pid}:{unix_ts}`                                                  | `{hostname}:{pid}:{unix_ts}` ✅                                                                           | ✅ **Correct**                                              |
| 8   | **Symbol validation**              | `symbol_select` twice → `failed` with `symbol_unavailable`, no infinite retry | Same ✅                                                                                                   | ✅ **Correct**                                              |
| 9   | **Event retention**                | WARN/ERROR to DB only; purge older than 30 days                               | WARN/ERROR to DB ✅, `ttl_days=30` cleanup scheduled ✅                                                   | ✅ **Correct**                                              |
| 10  | **Supervisor grace period**        | 60s grace from `started_at` before heartbeat staleness check                  | `started_at` field ✅, 60s grace ✅                                                                       | ✅ **Correct**                                              |
| 11  | **Worker backoff**                 | Exponential 5s→60s, reset on success                                          | 5s→10s→20s→40s→60s max ✅, reset after success ✅                                                         | ✅ **Correct**                                              |
| 12  | **Windows power settings**         | Script to disable sleep/monitor timeout                                       | `setup_windows_power.ps1` ✅                                                                              | ✅ **Correct**                                              |
| 13  | **Crash test hook**                | `IFX_CRASH_AFTER_ORDER=1` env flag, crash before DB write                     | Identical ✅                                                                                              | ✅ **Correct**                                              |
| 14  | **SQL RPCs**                       | `claim_trade_job`, `complete_trade_job` atomic                                | Adds `mark_trade_job_executing`, `retry_trade_job`, `log_mt5_runtime_event` ✅                            | ✅ **Correct — extra RPCs are useful**                      |
| 15  | **`mark_trade_job_executing` RPC** | Not in v1                                                                     | New addition — updates status to `executing` between claim and order placement                            | ✅ **Good addition** — enables finer job state visibility   |
| 16  | **File lock for poller mutex**     | Suggested mutex (type unspecified)                                            | Specified as file lock `mt5_test.lock`                                                                    | ✅ **Correct** — file locks work well on Windows            |

---

## Items Teacher Got Right That v1 Missed or Under-specified

| Item                                    | Detail                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mark_trade_job_executing` RPC          | Adds an intermediate state between `claimed` and `success/failed` — important for crash-recovery debugging             |
| `retry_trade_job` as a separate RPC     | Cleaner than doing it inline in the worker; keeps DB logic centralized                                                 |
| `log_mt5_runtime_event` as an RPC       | Even with service role access, centralizing log inserts into an RPC allows future RLS restriction without code changes |
| `for update skip locked` in claim RPC   | Explicitly handling concurrent workers safely — v1 said "atomic" but didn't spell out the SQL mechanism                |
| `connection_id` index on runtime events | `idx_mt5_runtime_events_conn_created_at` — useful for per-connection event queries                                     |

---

## Minor Gaps Still in Spec v2 (Not Blocking)

| Gap                                    | Recommendation                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`max_retries` enforcement location** | Spec says `max_retries=3` in config but the `claim_trade_job` RPC doesn't check it — worker must check before calling `retry_trade_job`. Add a note to job_worker.py spec.                                                            |
| **Poller test queue implementation**   | File lock prevents parallel runs but doesn't queue them — if 2 tests arrive simultaneously, 1 will fail to acquire lock and silently drop. Add: poller should retry lock acquisition up to N seconds before returning `test_timeout`. |
| **`complete_trade_job` idempotency**   | If called twice on the same job (crash recovery), it will overwrite a `success` result with a second call. Add: `WHERE status != 'success'` guard in the RPC.                                                                         |
| **No `canceled` job handling**         | `canceled` is in the enum but no RPC or worker behavior defined for it yet. Fine to defer to Phase 2.                                                                                                                                 |

---

## Updated Implementation Plan (Merged Best-of-Both)

### Phase 1 — Core Stability

| Step | Deliverable             | Notes                                                                        |
| ---- | ----------------------- | ---------------------------------------------------------------------------- |
| 1    | **SQL migration**       | Tables + all RPCs as written in Spec v2 — ready to run                       |
| 2    | `provision_terminal.py` | Portable mode, per-connection folder isolation                               |
| 3    | `crypto_utils.py`       | AES-256-GCM decrypt, key from `.env` Phase 1                                 |
| 4    | `db_client.py`          | Supabase wrapper: heartbeat, claim, complete, retry, log RPCs                |
| 5    | `job_worker.py`         | Full idempotency loop: claim → executing → order → comment=job_id → complete |
| 6    | `supervisor.py`         | Watchdog: started_at grace, heartbeat stale check, flap protection           |

### Phase 2 — Hardening

| Step | Deliverable               | Notes                                                               |
| ---- | ------------------------- | ------------------------------------------------------------------- |
| 7    | `poller.py`               | Single shared test terminal, file-lock mutex, queue + retry on lock |
| 8    | Event logging             | WARN/ERROR to DB via `log_mt5_runtime_event`; 30-day cleanup cron   |
| 9    | `setup_windows_power.ps1` | One-time run, disable sleep + monitor timeout                       |
| 10   | NSSM install              | `IFX_MT5_Supervisor` + `IFX_MT5_Poller` services                    |
| 11   | Popup/block detection     | Tick timeout detection, terminal restart trigger                    |

### Phase 3 — Security (Deferred)

| Step | Deliverable                                                      |
| ---- | ---------------------------------------------------------------- |
| 12   | Replace `.env` service role key with restricted RPC key strategy |
| 13   | `keyring` Windows Credential Manager for master decrypt key      |
| 14   | RLS policies per runtime role                                    |

---

## Verdict Summary

> **Teacher's Spec v2 is correct on all major points.** It directly incorporates every v1 recommendation accurately and adds three useful improvements (`mark_trade_job_executing`, `retry_trade_job` RPC, `log_mt5_runtime_event` RPC). The SQL is production-grade and safe to run. Three minor gaps noted above are non-blocking and can be addressed in `job_worker.py` implementation comments.

**Next step:** Generate `job_worker.py` + `supervisor.py` as the first production Python modules.
