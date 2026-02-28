"""
db_client.py
IFX MT5 Runtime — Supabase wrapper.

All DB interaction goes through this module.
Never import supabase directly in worker/supervisor.
"""

import logging
import os
import socket
from datetime import datetime, timezone
from typing import Optional

from supabase import Client, create_client

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Client singleton
# ---------------------------------------------------------------------------

_client: Optional[Client] = None


def get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _client = create_client(url, key)
    return _client


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

    get_client().table("mt5_worker_heartbeats").upsert(
        payload, on_conflict="connection_id"
    ).execute()


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
    return data if isinstance(data, dict) else data[0]


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
