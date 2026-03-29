"""
db_client.py
IFX MT5 Runtime — Supabase wrapper.

All DB interaction goes through this module.
Never import supabase directly in worker/supervisor.
"""

import logging
import os
import socket
import time
from datetime import datetime, timezone
from typing import Optional

from supabase import Client, create_client
from supabase.lib.client_options import SyncClientOptions

logger = logging.getLogger(__name__)
TERMINAL_TERMS_VERSION = "2026-03-28-v1"

# ---------------------------------------------------------------------------
# Client singleton
# ---------------------------------------------------------------------------

_client: Optional[Client] = None

_dotenv_loaded = False


def _maybe_load_dotenv() -> None:
    """Best-effort .env bootstrap.

    `main.py` usually loads .env, but worker/supervisor may be launched directly
    (or by external schedulers). Loading here makes runtime entrypoints robust.
    """
    global _dotenv_loaded
    if _dotenv_loaded:
        return
    _dotenv_loaded = True
    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv()
    except Exception:
        return


def _require_env(name: str) -> str:
    val = os.environ.get(name)
    if val:
        return val
    raise KeyError(
        f"Missing required env var: {name}. "
        "Make sure you have a .env file or start via main.py."
    )


def get_client() -> Client:
    global _client
    if _client is None:
        _maybe_load_dotenv()

        url = _require_env("SUPABASE_URL")
        key = _require_env("SUPABASE_SERVICE_ROLE_KEY")
        # Avoid long hangs in background threads (e.g., heartbeat keepalive) if the
        # network stalls. Keep this comfortably below HEARTBEAT_STALE_SEC.
        timeout_sec_raw = os.environ.get("SUPABASE_POSTGREST_TIMEOUT_SEC", "8")
        try:
            timeout_sec = float(timeout_sec_raw)
        except Exception:
            timeout_sec = 8.0
        _client = create_client(
            url,
            key,
            options=SyncClientOptions(postgrest_client_timeout=timeout_sec),
        )
    return _client


def _format_supabase_exc(exc: Exception) -> str:
    parts: list[str] = [repr(exc)]
    for attr in ("message", "details", "hint", "code"):
        val = getattr(exc, attr, None)
        if val:
            parts.append(f"{attr}={val}")
    return " | ".join(parts)


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------


def get_active_connections() -> list[dict]:
    """
    Return active MT5 connections.
    Strategy:
      1. Try filtering on is_active=True (proper schema)
      2. If column missing, fall back to MT5_CONNECTION_IDS env var
         so the system works even before the full schema patch is applied.
    """
    try:
        resp = (
            get_client()
            .table("mt5_user_connections")
            .select("*")
            .eq("is_active", True)
            .execute()
        )
        return resp.data or []
    except Exception as exc:
        msg = str(exc)
        if "is_active" in msg or "42703" in msg:
            # Schema not patched yet — fall back to env var connection IDs
            logger.warning(
                "is_active column missing — falling back to MT5_CONNECTION_IDS env var. "
                "Run patch_connections_table.sql in Supabase to fix permanently."
            )
            conn_ids_raw = os.environ.get("MT5_CONNECTION_IDS", "")
            conn_ids = [c.strip() for c in conn_ids_raw.split(",") if c.strip()]
            if not conn_ids:
                logger.error("MT5_CONNECTION_IDS env var is empty — no connections to manage.")
                return []
            # Fetch those rows individually
            resp = (
                get_client()
                .table("mt5_user_connections")
                .select("*")
                .in_("id", conn_ids)
                .execute()
            )
            return resp.data or []
        raise


def update_connection_status(connection_id: str, status: str, error: str = None) -> None:
    """Update connection status and related columns directly."""
    payload: dict = {
        "status": status,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }
    if error is not None:
        payload["last_error"] = error
    if status == "online":
        payload["last_ok_at"] = datetime.now(timezone.utc).isoformat()

    try:
        get_client().table("mt5_user_connections").update(payload).eq(
            "id", connection_id
        ).execute()
    except Exception as exc:
        logger.warning("update_connection_status failed: %s", exc)



# ---------------------------------------------------------------------------
# Heartbeats
# ---------------------------------------------------------------------------


def upsert_heartbeat(
    connection_id: str,
    pid: int,
    status: str,
    terminal_path: str = None,
    mt5_initialized: bool = False,
    account_login: str = None,
    last_metrics: dict = None,
    started_at: str = None,
) -> None:
    """Upsert a worker heartbeat row."""
    payload = {
        "connection_id": connection_id,
        "pid": pid,
        "host": socket.gethostname(),
        "status": status,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
        "mt5_initialized": mt5_initialized,
        "last_metrics": last_metrics or {},
    }
    if terminal_path:
        payload["terminal_path"] = terminal_path
    if account_login:
        payload["account_login"] = account_login
    if started_at:
        payload["started_at"] = started_at

    try:
        get_client().table("mt5_worker_heartbeats").upsert(
            payload, on_conflict="connection_id"
        ).execute()
    except Exception as exc:
        # Avoid log spam: only log a detailed message once per connection per 30s.
        now = time.time()
        cache = globals().setdefault("_HB_ERR_LAST", {})
        last = cache.get(connection_id, 0.0)
        if now - last >= 30.0:
            cache[connection_id] = now
            logger.warning(
                "upsert_heartbeat failed for %s (status=%s pid=%s): %s",
                connection_id,
                status,
                pid,
                _format_supabase_exc(exc),
            )
        raise


def get_all_heartbeats() -> list[dict]:
    """Return all heartbeat rows (used by supervisor)."""
    resp = get_client().table("mt5_worker_heartbeats").select("*").execute()
    return resp.data or []


def delete_heartbeat(connection_id: str) -> None:
    """Remove heartbeat row when worker exits cleanly."""
    get_client().table("mt5_worker_heartbeats").delete().eq(
        "connection_id", connection_id
    ).execute()


# ---------------------------------------------------------------------------
# Trade Jobs — RPCs
# ---------------------------------------------------------------------------


def claim_trade_job(
    connection_id: str,
    claimed_by: str,
    claim_timeout_seconds: int = 60,
) -> Optional[dict]:
    """
    Atomically claim the oldest queued/retry job for this connection.
    Also reclaims orphaned 'claimed' jobs stuck longer than claim_timeout_seconds.
    Returns the job dict or None if no job available.
    """
    resp = get_client().rpc(
        "claim_trade_job",
        {
            "p_connection_id": connection_id,
            "p_claimed_by": claimed_by,
            "p_claim_timeout_seconds": claim_timeout_seconds,
        },
    ).execute()
    data = resp.data
    if not data:
        return None

    job = data if isinstance(data, dict) else data[0]
    if not isinstance(job, dict):
        return None

    # Some RPC implementations can return a null-record shape instead of no row.
    # Treat that as "no job" so workers do not busy-loop on phantom claims.
    if not job.get("id"):
        return None

    return job


def mark_trade_job_executing(job_id: str) -> Optional[dict]:
    """Set job status = executing (called right before order_send)."""
    resp = get_client().rpc(
        "mark_trade_job_executing",
        {"p_job_id": job_id},
    ).execute()
    data = resp.data
    if not data:
        return None
    return data if isinstance(data, dict) else data[0]


def complete_trade_job(
    job_id: str,
    status: str,
    result: dict = None,
    error: str = None,
    error_code: str = None,
) -> Optional[dict]:
    """
    Finalize a job as success or failed.
    RPC guards against overwriting an existing success.
    """
    resp = get_client().rpc(
        "complete_trade_job",
        {
            "p_job_id": job_id,
            "p_status": status,
            "p_result": result or {},
            "p_error": error,
            "p_error_code": error_code,
        },
    ).execute()
    data = resp.data
    if not data:
        return None
    return data if isinstance(data, dict) else data[0]


def retry_trade_job(
    job_id: str,
    error: str,
    error_code: str = None,
) -> Optional[dict]:
    """Increment retry_count and set status = retry."""
    resp = get_client().rpc(
        "retry_trade_job",
        {
            "p_job_id": job_id,
            "p_error": error,
            "p_error_code": error_code,
        },
    ).execute()
    data = resp.data
    if not data:
        return None
    return data if isinstance(data, dict) else data[0]


# ---------------------------------------------------------------------------
# Event Logging (WARN / ERROR only go to DB)
# ---------------------------------------------------------------------------


def log_event(
    level: str,
    component: str,
    message: str,
    connection_id: str = None,
    details: dict = None,
) -> None:
    """
    Write a runtime event to mt5_runtime_events.
    Only call for level='warn' or level='error'.
    INFO stays in local log files.
    """
    if level == "info":
        logger.info("[%s] %s | %s", component, connection_id or "-", message)
        return

    try:
        get_client().rpc(
            "log_mt5_runtime_event",
            {
                "p_connection_id": connection_id,
                "p_level": level,
                "p_component": component,
                "p_message": message,
                "p_details": details or {},
            },
        ).execute()
    except Exception as exc:
        # Never crash on logging failure — just emit locally
        logger.error("Failed to write event to DB: %s", exc)

    # Always also log locally
    log_fn = logger.warning if level == "warn" else logger.error
    log_fn("[%s][%s] %s | details=%s", component, connection_id or "-", message, details)


def _is_within_enabled_session(sessions: dict | None) -> bool:
    """Mirror frontend/server session windows for runtime-side guard checks."""
    if not sessions:
        return True
    if not sessions.get("london") and not sessions.get("newYork") and not sessions.get("asia"):
        return False

    now = datetime.now(timezone.utc)
    utc_hour = now.hour + (now.minute / 60.0)

    if sessions.get("london") and 8 <= utc_hour < 16.5:
        return True
    if sessions.get("newYork") and 13 <= utc_hour < 21:
        return True
    if sessions.get("asia") and (utc_hour >= 23 or utc_hour < 8):
        return True

    return False


def _is_missing_relation_error(exc: Exception) -> bool:
    msg = _format_supabase_exc(exc).lower()
    return (
        "does not exist" in msg
        or "relation" in msg
        or "schema cache" in msg
    )


def get_terminal_execution_blocker(
    user_id: str | None,
    connection_id: str,
    trade_volume: float | None = None,
) -> Optional[str]:
    """
    Mirror terminal execution guardrails so runtime-triggered Trade Now orders
    can be rejected cleanly when account rules no longer allow execution.
    """
    if not user_id:
        return None

    client = get_client()
    try:
        settings_resp = (
            client
            .table("user_terminal_settings")
            .select("preferences_json, terms_version")
            .eq("user_id", user_id)
            .maybeSingle()
            .execute()
        )
    except Exception as exc:
        if _is_missing_relation_error(exc):
            return None
        return f"Failed to validate terminal settings: {getattr(exc, 'message', str(exc))}"

    settings = settings_resp.data or {}
    if not settings or settings.get("terms_version") != TERMINAL_TERMS_VERSION:
        return "Accept the current terminal terms before queueing live MT5 execution."

    prefs = settings.get("preferences_json") or {}

    max_trades_per_day = int(prefs.get("maxTradesPerDay") or 0)
    if max_trades_per_day > 0:
        try:
            daily_resp = client.rpc(
                "count_daily_trades",
                {"p_connection_id": connection_id},
            ).execute()
            daily_trades = int(daily_resp.data or 0)
        except Exception as exc:
            return f"Failed to validate daily trade limit: {getattr(exc, 'message', str(exc))}"
        if daily_trades >= max_trades_per_day:
            return f"Daily trade limit reached: {daily_trades}/{max_trades_per_day}."

    if not _is_within_enabled_session(prefs.get("sessions")):
        return "No enabled trading session is currently active. Enable a session or wait for your session window."

    max_position_size_lots = float(prefs.get("maxPositionSizeLots") or 0)
    if max_position_size_lots > 0 and trade_volume and trade_volume > max_position_size_lots:
        return f"Trade volume {trade_volume} lots exceeds your max position size of {max_position_size_lots} lots."

    daily_loss_limit_usd = float(prefs.get("dailyLossLimitUsd") or 0)
    daily_profit_target_usd = float(prefs.get("dailyProfitTargetUsd") or 0)
    max_drawdown_percent = float(prefs.get("maxDrawdownPercent") or 0)
    needs_heartbeat = any(v > 0 for v in (daily_loss_limit_usd, daily_profit_target_usd, max_drawdown_percent))

    if needs_heartbeat:
        try:
            hb_resp = (
                client
                .table("mt5_worker_heartbeats")
                .select("last_metrics")
                .eq("connection_id", connection_id)
                .maybeSingle()
                .execute()
            )
            hb = hb_resp.data or {}
        except Exception:
            hb = {}

        metrics = hb.get("last_metrics") or {}
        if metrics:
            balance = float(metrics.get("balance") or 0)
            equity = float(metrics.get("equity") or 0)
            floating_profit = float(metrics.get("profit") or 0)

            if daily_loss_limit_usd > 0 and floating_profit < -daily_loss_limit_usd:
                return f"Daily loss limit of ${daily_loss_limit_usd:g} reached (floating P&L: ${floating_profit:.2f})."
            if daily_profit_target_usd > 0 and floating_profit >= daily_profit_target_usd:
                return f"Daily profit target of ${daily_profit_target_usd:g} reached — new trades are locked for today."
            if max_drawdown_percent > 0 and balance > 0:
                drawdown = ((balance - equity) / balance) * 100.0
                if drawdown >= max_drawdown_percent:
                    return f"Max drawdown of {max_drawdown_percent:g}% reached (current: {drawdown:.1f}%)."

    return None


# ---------------------------------------------------------------------------
# Terminal settings — for news / session enforcement in job_worker
# ---------------------------------------------------------------------------

def get_terminal_prefs_for_connection(connection_id: str) -> dict:
    """
    Return the preferences_json dict from user_terminal_settings for the user
    that owns the given connection_id.

    Returns {} if the connection / settings row doesn't exist or on any error.
    Used by job_worker to check newsFilter, newsBeforeMin, newsAfterMin.
    """
    try:
        # Step 1: get user_id from connection row
        conn_resp = (
            get_client()
            .table("mt5_user_connections")
            .select("user_id")
            .eq("id", connection_id)
            .maybeSingle()
            .execute()
        )
        user_id = (conn_resp.data or {}).get("user_id")
        if not user_id:
            return {}

        # Step 2: get preferences from user_terminal_settings
        prefs_resp = (
            get_client()
            .table("user_terminal_settings")
            .select("preferences_json")
            .eq("user_id", user_id)
            .maybeSingle()
            .execute()
        )
        return (prefs_resp.data or {}).get("preferences_json") or {}
    except Exception as exc:
        logger.debug("get_terminal_prefs_for_connection(%s) failed: %s", connection_id, exc)
        return {}


# ---------------------------------------------------------------------------
# Economic events — Supabase sync for frontend calendar display
# ---------------------------------------------------------------------------

def upsert_economic_events(events: list[dict]) -> int:
    """
    Upsert economic calendar events to Supabase 'economic_events' table.
    Requires the table from docs/economic_events_migration.sql to exist.

    Returns number of rows upserted, or 0 on failure.
    """
    if not events:
        return 0

    try:
        import json as _json

        rows = []
        for ev in events:
            # Serialize event_json if it's a dict (Supabase client needs dict, not str)
            event_json = ev.get("event_json", {})
            if isinstance(event_json, str):
                try:
                    event_json = _json.loads(event_json)
                except Exception:
                    event_json = {}

            rows.append({
                "id":               ev["id"],
                "provider":         ev["provider"],
                "currency":         ev["currency"],
                "country":          ev["country"],
                "title":            ev["title"],
                "impact":           ev["impact"],
                "scheduled_at_utc": ev["scheduled_at_utc"],
                "category":         ev.get("category", "macro"),
                "event_json":       event_json,
                "synced_at":        datetime.now(timezone.utc).isoformat(),
            })

        # Batch in chunks to stay well within PostgREST limits
        chunk_size = 100
        total = 0
        for i in range(0, len(rows), chunk_size):
            chunk = rows[i : i + chunk_size]
            get_client().table("economic_events").upsert(
                chunk, on_conflict="id"
            ).execute()
            total += len(chunk)

        return total
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" in msg or "relation" in msg or "schema cache" in msg:
            logger.warning(
                "upsert_economic_events: 'economic_events' table missing. "
                "Run docs/economic_events_migration.sql in Supabase first."
            )
        else:
            logger.warning("upsert_economic_events failed: %s", exc)
        return 0
