"""runtime.mt5_candles

Broker-native candle fetching via the MetaTrader5 Python API.

Key requirement (architecture rule):
- Do NOT synthesize higher timeframes from 1m candles.
- Always use the broker/terminal's own candles for the requested timeframe.

This module is intentionally lightweight so it can be used by both the relay
(SetupManager structure detection) and any other runtime components.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Optional

from datetime import datetime, timezone


class Mt5CandlesError(RuntimeError):
    pass


def _truthy_env(name: str) -> bool:
    v = (os.getenv(name) or "").strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def _repo_root() -> Path:
    # runtime/ is directly under the repo root
    return Path(__file__).resolve().parent.parent


def _terminal_path_for_connection(connection_id: str) -> Optional[str]:
    base_dir = (os.getenv("MT5_TERMINAL_BASE_DIR") or "").strip()
    if not base_dir:
        # Reasonable default for this repo.
        base_dir = str(_repo_root() / "terminals")

    candidate = Path(base_dir) / connection_id / "terminal64.exe"
    if candidate.exists():
        return str(candidate)

    # Fallback: explicit terminal path (single-terminal deployments)
    terminal_path = (os.getenv("MT5_TERMINAL_PATH") or "").strip()
    if terminal_path and Path(terminal_path).exists():
        return terminal_path

    return None


def _ipc_lock_path() -> str:
    # Keep same filename/location convention as runtime/poller.py.
    return str(Path(__file__).resolve().parent / "mt5_ipc.lock")


class _Mt5IpcLock:
    """Optional cross-process lock to serialize MT5 IPC.

    Enabled when `MT5_GLOBAL_IPC_LOCK=1`.
    """

    def __init__(self) -> None:
        self._fh = None
        self._acquired = False

    def __enter__(self) -> "_Mt5IpcLock":
        if os.name != "nt" or not _truthy_env("MT5_GLOBAL_IPC_LOCK"):
            return self

        import msvcrt

        timeout_s_raw = (os.getenv("MT5_GLOBAL_IPC_LOCK_TIMEOUT_SECONDS") or "").strip()
        timeout_s = float(timeout_s_raw) if timeout_s_raw else 120.0
        start = time.time()

        fh = open(_ipc_lock_path(), "a+", encoding="utf-8")
        self._fh = fh
        while True:
            try:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                self._acquired = True
                return self
            except OSError:
                if (time.time() - start) >= timeout_s:
                    raise Mt5CandlesError(
                        f"timed out waiting for MT5 IPC lock after {timeout_s:.1f}s"
                    )
                time.sleep(0.1)

    def __exit__(self, exc_type, exc, tb) -> None:
        if os.name != "nt" or not _truthy_env("MT5_GLOBAL_IPC_LOCK"):
            return

        import msvcrt

        try:
            if self._fh and self._acquired:
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            try:
                if self._fh:
                    self._fh.close()
            except Exception:
                pass


_session_lock = threading.Lock()
_session_conn_id: Optional[str] = None
_session_ready: bool = False

# Debug/status cache (avoid expensive MT5 IPC on rapid polling)
_status_cache_lock = threading.Lock()
_status_cache: dict[tuple[str, str, str], tuple[float, dict]] = {}


def _ensure_session_for_connection(connection_id: str) -> bool:
    """Ensure MT5 is initialized against the terminal for this connection."""
    global _session_conn_id, _session_ready

    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception as e:
        raise Mt5CandlesError(
            "MetaTrader5 package not available; cannot fetch broker candles. "
            f"({type(e).__name__}: {e})"
        )

    # Fast path: already initialized and connected.
    if _session_ready and _session_conn_id == connection_id:
        info = mt5.terminal_info()
        if info and getattr(info, "connected", False):
            return True
        _session_ready = False

    # Switching terminals (or recovering): shutdown first.
    try:
        mt5.shutdown()
    except Exception:
        pass

    terminal_path = _terminal_path_for_connection(connection_id)
    if not terminal_path:
        raise Mt5CandlesError(
            "Cannot locate MT5 terminal for connection. "
            "Set MT5_TERMINAL_BASE_DIR or MT5_TERMINAL_PATH. "
            f"connection_id={connection_id}"
        )

    timeout_ms_raw = (os.getenv("MT5_TERMINAL_TIMEOUT_MS") or "").strip()
    timeout_ms = int(timeout_ms_raw) if timeout_ms_raw.isdigit() else 60000

    # If we're using a per-connection base dir, portable mode is correct.
    portable = True
    if "MT5_TERMINAL_PORTABLE" in os.environ:
        portable = _truthy_env("MT5_TERMINAL_PORTABLE")

    ok = mt5.initialize(path=str(terminal_path), portable=portable, timeout=timeout_ms)
    if not ok:
        _session_conn_id = None
        _session_ready = False
        return False

    _session_conn_id = connection_id
    _session_ready = True
    return True


_TF_MAP = {
    "1m": "TIMEFRAME_M1",
    "3m": "TIMEFRAME_M3",
    "5m": "TIMEFRAME_M5",
    "15m": "TIMEFRAME_M15",
    "30m": "TIMEFRAME_M30",
    "1h": "TIMEFRAME_H1",
    "4h": "TIMEFRAME_H4",
    "1d": "TIMEFRAME_D1",
}


def get_broker_candles(
    connection_id: str,
    symbol: str,
    timeframe: str,
    count: int = 200,
    include_current: bool = False,
) -> list[dict]:
    """Fetch the last `count` CLOSED candles from the broker terminal.

    Returns bars in ascending time order, each in the relay/engine format:
      {"t": int, "o": float, "h": float, "l": float, "c": float, "v": int}

    Notes:
    - By default uses `copy_rates_from_pos(..., start_pos=1)` to exclude the current forming bar.
    - If `include_current=True`, uses `start_pos=0` (includes the current forming candle).
    """
    tf_key = (timeframe or "").strip().lower()
    tf_name = _TF_MAP.get(tf_key)
    if not tf_name:
        tf_key = "5m"
        tf_name = _TF_MAP[tf_key]

    symbol = (symbol or "").strip()
    if not symbol:
        return []

    with _session_lock:
        with _Mt5IpcLock():
            import MetaTrader5 as mt5  # type: ignore

            if not _ensure_session_for_connection(connection_id):
                return []

            # Make symbol visible.
            try:
                mt5.symbol_select(symbol, True)
            except Exception:
                pass

            tf_const = getattr(mt5, tf_name, None)
            if tf_const is None:
                # Some MT5 builds may not support M3.
                return []

            start_pos = 0 if include_current else 1
            rates = mt5.copy_rates_from_pos(symbol, tf_const, int(start_pos), int(count))
            if rates is None or len(rates) == 0:
                return []

            bars = [
                {
                    "t": int(r["time"]),
                    "o": float(r["open"]),
                    "h": float(r["high"]),
                    "l": float(r["low"]),
                    "c": float(r["close"]),
                    "v": int(r["tick_volume"]),
                }
                for r in rates
            ]

    # Ensure ascending order (oldest -> newest)
    bars.sort(key=lambda b: int(b["t"]))
    return bars


def get_mt5_status(connection_id: str, symbol: str, timeframe: str) -> dict:
    """Return a small diagnostic snapshot for alignment debugging.

    All timestamps returned are the raw epoch seconds provided by MT5.
    """
    ttl_raw = (os.getenv("IFX_MT5_STATUS_CACHE_SECONDS") or "").strip()
    try:
        ttl_s = float(ttl_raw) if ttl_raw else 1.5
    except Exception:
        ttl_s = 1.5

    cache_key = (connection_id, symbol, timeframe)
    now = time.monotonic()
    with _status_cache_lock:
        cached = _status_cache.get(cache_key)
        if cached and (now - float(cached[0])) <= ttl_s:
            return cached[1]

    ok = _ensure_session_for_connection(connection_id)
    if not ok:
        raise Mt5CandlesError("mt5.initialize failed")

    with _session_lock:
        with _Mt5IpcLock():
            import MetaTrader5 as mt5  # type: ignore

            term = mt5.terminal_info()
            acct = mt5.account_info()

            # Ensure symbol is selected before tick/candle reads.
            try:
                mt5.symbol_select(symbol, True)
            except Exception:
                pass

            tick = None
            try:
                tick = mt5.symbol_info_tick(symbol)
            except Exception:
                tick = None

            closed = get_broker_candles(connection_id, symbol, timeframe, count=2, include_current=False)
            with_current = get_broker_candles(connection_id, symbol, timeframe, count=2, include_current=True)

            # Defensive: always enforce ascending ordering.
            closed.sort(key=lambda b: int(b.get("t", 0) or 0))
            with_current.sort(key=lambda b: int(b.get("t", 0) or 0))

            def _iso(ts: Optional[int]) -> Optional[str]:
                if not ts:
                    return None
                return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()

            tick_time = None
            tick_time_msc = None
            if tick is not None:
                # MT5 provides `time` (sec) and `time_msc` (ms) on most builds.
                tick_time = int(getattr(tick, "time", 0) or 0)
                tick_time_msc = int(getattr(tick, "time_msc", 0) or 0)

            payload = {
                "connection_id": connection_id,
                "symbol": symbol,
                "timeframe": timeframe,
                "terminal": {
                    "connected": bool(getattr(term, "connected", False)) if term else None,
                    "trade_allowed": bool(getattr(term, "trade_allowed", False)) if term else None,
                    "community_account": bool(getattr(term, "community_account", False)) if term else None,
                },
                "account": {
                    "login": int(getattr(acct, "login", 0) or 0) if acct else None,
                    "server": str(getattr(acct, "server", "") or "") if acct else None,
                    "company": str(getattr(acct, "company", "") or "") if acct else None,
                },
                "tick": {
                    "time": tick_time,
                    "time_iso_utc": _iso(tick_time),
                    "time_msc": tick_time_msc,
                    "bid": float(getattr(tick, "bid", 0.0) or 0.0) if tick else None,
                    "ask": float(getattr(tick, "ask", 0.0) or 0.0) if tick else None,
                },
                "candles": {
                    "last_two_closed": closed,
                    "last_two_with_current": with_current,
                    "last_closed_t": int(closed[-1]["t"]) if closed else None,
                },
            }

            with _status_cache_lock:
                _status_cache[cache_key] = (now, payload)

            return payload
