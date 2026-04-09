#!/usr/bin/env python3
"""
IFX Price Bridge — Production Relay  (Sprint 3)
================================================
Sits between the MT5 EA (IFX_PriceBridge_v3) and the Railway backend.

                    ┌─────────────────────────────────┐
  MT5 EA ─────────▶│  HTTP :8082  (this file)         │─────▶  Railway WSS
  POST /tick-batch  │                                  │        /ws/mt5-relay
  POST /candle-close│  In-memory candle ring buffers   │
  POST /historical  │  Per-symbol 1m OHLCV deques      │
  GET  /config      │  On-the-fly TF aggregation       │
  GET  /candles     │  Auto-reconnect WebSocket fwd    │
  GET  /prices      └─────────────────────────────────┘

Environment vars (all optional with defaults):
    RELAY_PORT              8082
    RELAY_SECRET            HMAC signing secret (must match EA SigningSecret)
    RAILWAY_WS_URL          wss://... Railway WebSocket endpoint (Sprint 4)
    RAILWAY_RELAY_TOKEN     Bearer token for Railway WS auth
    RELAY_CANDLE_MAXBARS    1500 (1m bars per symbol, ~25 hours)

Run:
    python runtime/price_relay.py

Then attach MT5 EA with:
    BackendRelayUrl = http://127.0.0.1:8082
    SigningSecret   = <matches RELAY_SECRET>
"""

import collections
import hashlib
import hmac
import json
import logging
import os
import queue
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from runtime.mt5_candles import get_live_price_snapshots


def _acquire_single_instance_lock() -> None:
    """Prevent multiple relay instances from running at once (Windows-friendly)."""
    workspace_root = Path(__file__).resolve().parents[1]
    lock_path = workspace_root / ".price_relay.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(lock_path, "a+", encoding="utf-8")
    except Exception:
        return

    # Keep the handle alive for the lifetime of the process.
    globals()["_PRICE_RELAY_LOCK_FH"] = fh

    if os.name != "nt":
        return

    try:
        import msvcrt

        # Lock byte 0 (must seek before locking; Windows locks are relative
        # to the current file pointer).
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)

        # Best-effort: record PID for debugging.
        fh.seek(0)
        fh.truncate(0)
        fh.write(str(os.getpid()))
        fh.flush()
    except Exception:
        log.error("Another relay instance is already running; exiting.")
        raise SystemExit(0)


def _kill_non_venv_relay_duplicates() -> None:
    """Kill any other relay processes not running in the workspace venv.

    This prevents system-Python copies from competing on port 8082.
    """
    try:
        import psutil
    except Exception:
        return

    workspace_root = Path(__file__).resolve().parents[1]
    expected_venv_python = workspace_root / ".venv" / "Scripts" / "python.exe"
    expected_norm = os.path.normcase(os.path.abspath(str(expected_venv_python)))

    this_pid = os.getpid()
    relay_script_str = str((Path(__file__).resolve()))

    for proc in psutil.process_iter(attrs=["pid", "exe", "cmdline"]):
        try:
            if proc.info.get("pid") == this_pid:
                continue

            cmdline = proc.info.get("cmdline") or []
            if not cmdline:
                continue

            cmd_joined = " ".join(cmdline)
            if relay_script_str not in cmd_joined and "price_relay.py" not in cmd_joined:
                continue

            exe = proc.info.get("exe") or ""
            exe_norm = os.path.normcase(os.path.abspath(str(exe))) if exe else ""

            # If this relay is venv-based, we only kill non-venv ones.
            if expected_norm and exe_norm == expected_norm:
                continue

            try:
                proc.terminate()
            except Exception:
                pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue


def _load_dotenv(dotenv_path: Path) -> None:
    """Best-effort .env loader (does not override existing env vars)."""
    try:
        if not dotenv_path.exists():
            return
        for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if (not line) or line.startswith("#") or ("=" not in line):
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        # Never fail relay startup because of a dotenv parsing issue.
        return

# ─── Logging ─────────────────────────────────────────────────────────────────

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [RELAY] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "price_relay.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("price_relay")

# ─── Config ───────────────────────────────────────────────────────────────────

# Load workspace .env (so the relay can be configured consistently with the rest
# of the runtime). Environment variables already present take precedence.
_WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
_load_dotenv(_WORKSPACE_ROOT / ".env")

# ─── Setup state machine (optional — no-op if Supabase not configured) ─────────
# IMPORTANT: this block must run AFTER _load_dotenv() so that SUPABASE_URL is
# present in os.environ when setup_manager.start() checks for it.
try:
    _root = str(_WORKSPACE_ROOT)
    if _root not in sys.path:
        sys.path.insert(0, _root)
    from ai_engine.setup_manager import setup_manager as _setup_manager
    # If the env was missing at first import (shouldn't happen now), retry start.
    if not _setup_manager._started:
        _setup_manager.start()
    log.info("[relay] setup_manager imported OK — started=%s", _setup_manager._started)
except Exception as _sm_err:
    _setup_manager = None
    log.warning("[relay] setup_manager not available: %r — state machine disabled", _sm_err)


def _sm_on_tick_batch(conn_id: str, ticks: list) -> None:
    if _setup_manager is not None:
        _enqueue_setup_event("tick_batch", conn_id, ticks=ticks)


def _sm_on_candle_close(conn_id: str, symbol: str, bar: dict) -> None:
    if _setup_manager is not None:
        _enqueue_setup_event("candle_close", conn_id, symbol=symbol, bar=bar)


PORT             = int(os.getenv("RELAY_PORT", "8082"))
RELAY_SECRET     = os.getenv("RELAY_SECRET", "")              # blank = skip HMAC verify
RAILWAY_INGEST_URL = os.getenv("RAILWAY_INGEST_URL", "")      # https://....railway.app/api/mt5/ingest
RAILWAY_TOKEN    = os.getenv("RAILWAY_RELAY_TOKEN", "")       # Bearer token for Railway ingest
RELAY_SOURCE_CONNECTION_ID = (os.getenv("RELAY_SOURCE_CONNECTION_ID", "") or "").strip()
# Default to ~7 days of 1m data per symbol (override via RELAY_CANDLE_MAXBARS)
CANDLE_MAXBARS   = int(os.getenv("RELAY_CANDLE_MAXBARS", "10000"))

# Timeframe aggregation map  {tf_label -> minutes}
TF_MINUTES = {
    "1m":  1,
    "3m":  3,
    "5m":  5,
    "15m": 15,
    "30m": 30,
    "1h":  60,
    "4h":  240,
    "1d":  1440,
}

_sm_event_queue: queue.Queue | None = queue.Queue(maxsize=2000) if _setup_manager is not None else None


def _enqueue_setup_event(kind: str, conn_id: str, **payload) -> None:
    if _setup_manager is None or _sm_event_queue is None:
        return
    try:
        _sm_event_queue.put_nowait((kind, conn_id, payload))
    except queue.Full:
        log.warning("[relay] setup event queue full; dropping %s for %s", kind, conn_id[:8])


def _setup_event_loop() -> None:
    if _setup_manager is None or _sm_event_queue is None:
        return

    while True:
        kind, conn_id, payload = _sm_event_queue.get()
        try:
            if kind == "tick_batch":
                _setup_manager.on_tick_batch(conn_id, payload.get("ticks", []))
            elif kind == "candle_close":
                _setup_manager.on_candle_close(conn_id, payload.get("symbol", ""), payload.get("bar", {}))
        except Exception as _e:
            log.debug("setup_manager.%s error: %r", kind, _e)
        finally:
            _sm_event_queue.task_done()

MOCK_SYMBOLS = [
    "EURUSDm", "GBPUSDm", "USDJPYm", "USDCADm", "AUDUSDm",
    "NZDUSDm", "USDCHFm", "EURGBPm", "XAUUSDm", "BTCUSDm",
    "ETHUSDm", "USOILm",
]

# ─── In-memory state ──────────────────────────────────────────────────────────
#
#  candle_buffer[conn_id][symbol]  — deque of closed 1m OHLCV dicts (oldest→newest)
#      each entry: {"t": epoch_s, "o": float, "h": float, "l": float, "c": float, "v": int}
#
#  forming[conn_id][symbol]        — current forming 1m bar (live, updating every 150ms)
#
#  latest_price[conn_id][symbol]   — {"bid": float, "ask": float, "ts_ms": int}
#
#  config_symbols[conn_id]         — list of symbol strings for this connection

_state_lock    = threading.Lock()
candle_buffer  = collections.defaultdict(lambda: collections.defaultdict(
    lambda: collections.deque(maxlen=CANDLE_MAXBARS)
))
forming        = collections.defaultdict(dict)   # conn_id -> {symbol -> bar}
latest_price   = collections.defaultdict(dict)   # conn_id -> {symbol -> {bid,ask,ts}}
config_symbols = collections.defaultdict(list)   # conn_id -> [symbol, ...]

# ─── SSE client registry ──────────────────────────────────────────────────────
# Each connected browser gets a queue + connection filter. The broadcaster
# only forwards events for that connection to avoid cross-account symbol bleed.
_sse_clients: list = []                  # list[dict(queue=queue.Queue, conn_id=str)]
_sse_lock    = threading.Lock()

# Pending tick accumulator: filled by _handle_tick_batch, drained by broadcaster
_pending_broadcast: dict = {}           # conn_id -> {symbol -> {bid,ask,ts_ms}}
_pending_forming: dict  = {}           # conn_id -> {symbol -> {t,o,h,l,c,v}}
_pending_lock = threading.Lock()

SSE_INTERVAL_S = max(0.05, float(os.getenv("SSE_INTERVAL_MS", "50")) / 1000)  # default 50ms
DIRECT_PRICE_MAX_AGE_MS = max(500, int(os.getenv("DIRECT_PRICE_MAX_AGE_MS", "1000") or "1000"))
DIRECT_PRICE_POLL_SECONDS = max(0.1, float(os.getenv("DIRECT_PRICE_POLL_SECONDS", "0.10") or "0.10"))
DEFAULT_DIRECT_SYMBOLS = [
    "BTCUSDm", "ETHUSDm", "EURUSDm", "GBPUSDm", "USDJPYm", "XAUUSDm",
    "USDCADm", "AUDUSDm", "NZDUSDm", "USDCHFm", "EURGBPm", "USOILm",
]
DIRECT_CONN_REFRESH_SECONDS = max(5.0, float(os.getenv("DIRECT_CONN_REFRESH_SECONDS", "15") or "15"))
_direct_conn_cache: tuple[float, list[str]] = (0.0, [])


def _newest_price_ts_ms(prices: dict) -> int:
    newest = 0
    for snap in prices.values():
        try:
            ts_ms = int((snap or {}).get("ts_ms") or 0)
        except Exception:
            ts_ms = 0
        if ts_ms > newest:
            newest = ts_ms
    return newest


def _resolve_price_symbols(conn_id: str) -> list[str]:
    with _state_lock:
        configured = list(config_symbols.get(conn_id, []))
        cached = list(latest_price.get(conn_id, {}).keys())
        forming_symbols = list(forming.get(conn_id, {}).keys())
    ordered = configured + cached + forming_symbols + DEFAULT_DIRECT_SYMBOLS
    seen: set[str] = set()
    result: list[str] = []
    for raw in ordered:
        sym = str(raw or "").strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        result.append(sym)
    return result


def _refresh_direct_prices(conn_id: str) -> dict:
    if not conn_id:
        return {}
    symbols = _resolve_price_symbols(conn_id)
    if not symbols:
        return {}
    try:
        snapshots = get_live_price_snapshots(conn_id, symbols)
    except Exception as exc:
        log.debug(f"direct price fallback failed conn={conn_id[:8]}: {exc!r}")
        return {}

    if snapshots:
        with _state_lock:
            latest_price[conn_id].update(snapshots)
    return snapshots


def _list_direct_price_connections() -> list[str]:
    global _direct_conn_cache

    if RELAY_SOURCE_CONNECTION_ID:
        return [RELAY_SOURCE_CONNECTION_ID]

    cached_at, cached_conn_ids = _direct_conn_cache
    now = time.time()
    if cached_conn_ids and (now - cached_at) < DIRECT_CONN_REFRESH_SECONDS:
        return list(cached_conn_ids)

    conn_ids: list[str] = []
    try:
        from runtime import db_client  # type: ignore

        active_rows = db_client.get_active_connections()
        for row in active_rows:
            conn_id = str((row or {}).get("id") or "").strip()
            if conn_id:
                conn_ids.append(conn_id)
    except Exception as exc:
        log.debug(f"direct price connection discovery failed: {exc!r}")

    with _state_lock:
        conn_ids.extend(list(config_symbols.keys()))
        conn_ids.extend(list(latest_price.keys()))
        conn_ids.extend(list(forming.keys()))

    seen: set[str] = set()
    result: list[str] = []
    for raw in conn_ids:
        conn_id = str(raw or "").strip()
        if not conn_id or conn_id in seen:
            continue
        seen.add(conn_id)
        result.append(conn_id)
    _direct_conn_cache = (now, list(result))
    return result


def _direct_price_forward_loop() -> None:
    """Poll direct MT5 prices for non-source connections and forward them.

    This keeps Railway state warm for accounts that do not have an EA-driven
    tick feed but do have a live local MT5 terminal/worker session.
    """
    while True:
        time.sleep(DIRECT_PRICE_POLL_SECONDS)
        try:
            conn_ids = _list_direct_price_connections()
            for conn_id in conn_ids:
                prices = _refresh_direct_prices(conn_id)
                if not prices:
                    continue

                with _pending_lock:
                    bucket = _pending_broadcast.setdefault(conn_id, {})
                    bucket.update(prices)

                ticks = [
                    {
                        "symbol": sym,
                        "bid": snap.get("bid"),
                        "ask": snap.get("ask"),
                        "ts_ms": snap.get("ts_ms"),
                    }
                    for sym, snap in prices.items()
                ]
                enqueue_ws({
                    "type": "tick_batch",
                    "connection_id": conn_id,
                    "ts_ms": _newest_price_ts_ms(prices),
                    "ticks": ticks,
                    "forming_candles": [],
                })
        except Exception as exc:
            log.debug(f"direct price forward loop error: {exc!r}")


def _broadcast_sse_event(msg: dict) -> None:
    """Push msg to matching SSE clients only (non-blocking)."""
    event_type = msg.get("type", "message")
    target_conn_id = str(msg.get("connection_id") or "").strip()
    payload = (f"event: {event_type}\ndata: {json.dumps(msg)}\n\n").encode()
    dead = []
    with _sse_lock:
        clients = list(_sse_clients)
    for client in clients:
        q = client.get("queue")
        client_conn_id = str(client.get("conn_id") or "").strip()
        if client_conn_id and target_conn_id and client_conn_id != target_conn_id:
            continue
        try:
            q.put_nowait(payload)
        except queue.Full:
            dead.append(client)
    if dead:
        with _sse_lock:
            for client in dead:
                try:
                    _sse_clients.remove(client)
                except ValueError:
                    pass


def _sse_broadcaster_loop() -> None:
    """Background thread: every SSE_INTERVAL_S drain pending ticks → broadcast."""
    while True:
        time.sleep(SSE_INTERVAL_S)
        with _pending_lock:
            if not _pending_broadcast and not _pending_forming:
                continue
            price_snap   = {k: dict(v) for k, v in _pending_broadcast.items()}
            forming_snap = {k: dict(v) for k, v in _pending_forming.items()}
            _pending_broadcast.clear()
            _pending_forming.clear()

        for conn_id, sym_prices in price_snap.items():
            _broadcast_sse_event({
                "type":          "prices",
                "connection_id": conn_id,
                "prices":        sym_prices,
            })

        for conn_id, sym_forming in forming_snap.items():
            _broadcast_sse_event({
                "type":          "candle_update",
                "connection_id": conn_id,
                "forming":       sym_forming,
            })

stats = {
    "tick_batches":    0,
    "ticks_total":     0,
    "candle_closes":   0,
    "historical_bulk": 0,
    "config_reqs":     0,
    "ws_sent":         0,
    "ws_dropped":      0,
    "t_start":         time.time(),
}


def _accepts_connection(conn_id: str) -> bool:
    """When a source lock is set, only accept data that can be remapped.
    When no lock is set, accept everything."""
    return True  # always accept; conn_id is remapped via _effective_conn_id

def _effective_conn_id(conn_id: str) -> str:
    """Return the conn_id to use for storage and forwarding.
    If RELAY_SOURCE_CONNECTION_ID is set, ALL incoming data is remapped to
    that ID regardless of the original sender — this pins market data to a
    single account without needing the EA to be reconfigured.
    """
    if RELAY_SOURCE_CONNECTION_ID:
        return RELAY_SOURCE_CONNECTION_ID
    return (conn_id or "default").strip()

# ─── Candle buffer disk persistence ──────────────────────────────────────────
BUFFER_FILE = LOG_DIR / "candle_buffer.json"
BUFFER_FILE_TMP = LOG_DIR / "candle_buffer.json.tmp"
BUFFER_FILE_BAK = LOG_DIR / "candle_buffer.json.bak"
BUFFER_AUTOSAVE_SECONDS = max(0, int(os.getenv("RELAY_BUFFER_AUTOSAVE_SECONDS", "0") or "0"))


def _iter_buffer_files() -> list[Path]:
    files: list[Path] = []
    if BUFFER_FILE.exists():
        files.append(BUFFER_FILE)
    if BUFFER_FILE_BAK.exists():
        files.append(BUFFER_FILE_BAK)
    return files

def save_buffer() -> None:
    """Persist candle_buffer to disk (called every 60s + on shutdown)."""
    try:
        with _state_lock:
            data = {cid: {sym: list(buf) for sym, buf in syms.items()}
                    for cid, syms in candle_buffer.items() if syms}
        with open(BUFFER_FILE_TMP, "w", encoding="utf-8") as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        try:
            if BUFFER_FILE.exists():
                BUFFER_FILE.replace(BUFFER_FILE_BAK)
        except Exception:
            pass
        BUFFER_FILE_TMP.replace(BUFFER_FILE)
    except Exception as exc:
        log.warning(f"save_buffer error: {exc!r}")
        try:
            if BUFFER_FILE_TMP.exists():
                BUFFER_FILE_TMP.unlink()
        except Exception:
            pass

def load_buffer() -> None:
    """Restore candle_buffer from disk on startup."""
    files = _iter_buffer_files()
    if not files:
        return
    last_exc: Exception | None = None
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            with _state_lock:
                for cid, sym_map in data.items():
                    for sym, bars in sym_map.items():
                        buf = candle_buffer[cid][sym]
                        for b in bars:
                            buf.append(b)
            total = sum(len(s) for c in data.values() for s in c.values())
            log.info(
                f"Loaded {total} bars from disk for {sum(len(v) for v in data.values())} symbols"
                f" ({path.name})"
            )
            if path != BUFFER_FILE:
                try:
                    BUFFER_FILE_BAK.replace(BUFFER_FILE)
                except Exception:
                    pass
            return
        except Exception as exc:
            last_exc = exc
            log.warning(f"load_buffer error from {path.name}: {exc!r}")
    if last_exc is not None:
        log.warning(f"load_buffer failed for all candidates; starting empty buffer: {last_exc!r}")

def _buffer_autosave_loop() -> None:
    """Background thread: save buffer to disk every 60 seconds."""
    if BUFFER_AUTOSAVE_SECONDS <= 0:
        log.info("Buffer autosave disabled (set RELAY_BUFFER_AUTOSAVE_SECONDS>0 to enable)")
        return
    while True:
        time.sleep(BUFFER_AUTOSAVE_SECONDS)
        save_buffer()

# ─── HTTP forwarder ───────────────────────────────────────────────────────────
#
#  Runs in a dedicated daemon thread.
#  HTTP handlers call enqueue_fwd(msg_dict) which is thread-safe.
#  When RAILWAY_INGEST_URL is blank, messages are discarded after logging.

_fwd_queue: queue.Queue = queue.Queue(maxsize=5000)
_fwd_tick_lock = threading.Lock()
_fwd_tick_batches: dict[str, dict] = {}
TICK_FORWARD_INTERVAL_S = max(
    0.05,
    float(os.getenv("RAILWAY_TICK_FORWARD_INTERVAL_SECONDS", "0.05") or "0.05"),
)


def enqueue_fwd(msg: dict) -> None:
    """Thread-safe: enqueue a message for forwarding to Railway ingest."""
    if not RAILWAY_INGEST_URL:
        return  # buffering only — no Railway endpoint configured
    if msg.get("type") == "tick_batch":
        conn_id = str(msg.get("connection_id") or "default").strip() or "default"
        with _fwd_tick_lock:
            prev = _fwd_tick_batches.get(conn_id)
            prev_ts = int((prev or {}).get("ts_ms") or 0)
            next_ts = int((msg or {}).get("ts_ms") or 0)
            if prev is None or next_ts >= prev_ts:
                _fwd_tick_batches[conn_id] = dict(msg)
        return
    try:
        if "_retry" not in msg:
            msg["_retry"] = 0
        _fwd_queue.put_nowait(msg)
    except queue.Full:
        stats["ws_dropped"] += 1


# Keep the old name as alias so existing call sites don't need changing
enqueue_ws = enqueue_fwd


def _tick_batch_enqueue_loop() -> None:
    """Coalesce latest tick batches per connection before HTTP forwarding.

    This prevents Railway ingest from falling behind on old price snapshots when
    the local relay is producing ticks faster than the remote API can accept.
    """
    while True:
        time.sleep(TICK_FORWARD_INTERVAL_S)
        with _fwd_tick_lock:
            if not _fwd_tick_batches:
                continue
            batches = list(_fwd_tick_batches.values())
            _fwd_tick_batches.clear()

        for msg in batches:
            try:
                if "_retry" not in msg:
                    msg["_retry"] = 0
                _fwd_queue.put_nowait(msg)
            except queue.Full:
                stats["ws_dropped"] += 1


def _http_relay_loop() -> None:
    """Drain _fwd_queue and POST each message to Railway /api/mt5/ingest."""
    if not RAILWAY_INGEST_URL:
        log.info("RAILWAY_INGEST_URL not set — HTTP forwarding disabled, buffer-only mode")
        while True:
            _fwd_queue.get()  # drain silently
            _fwd_queue.task_done()
        return  # unreachable but explicit

    headers: dict = {"Content-Type": "application/json", "Connection": "close"}
    if RAILWAY_TOKEN:
        headers["Authorization"] = f"Bearer {RAILWAY_TOKEN}"

    session = requests.Session()
    backoff = 1.0
    max_retries = 5
    log.info(f"HTTP relay -> target: {RAILWAY_INGEST_URL}")

    while True:
        msg = _fwd_queue.get()
        try:
            payload = {k: v for k, v in msg.items() if k != "_retry"}
            resp = session.post(
                RAILWAY_INGEST_URL,
                json=payload,
                headers=headers,
                timeout=5,
            )
            if resp.status_code < 300:
                stats["ws_sent"] += 1
                backoff = 1.0
            else:
                log.warning(f"Railway ingest HTTP {resp.status_code}: {resp.text[:80]}")
                stats["ws_dropped"] += 1
        except Exception as exc:
            retry_count = int(msg.get("_retry", 0)) + 1
            if retry_count <= max_retries:
                msg["_retry"] = retry_count
                log.warning(
                    f"Railway ingest error: {exc!r} - retry {retry_count}/{max_retries} in {backoff:.0f}s"
                )
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)
                try:
                    _fwd_queue.put_nowait(msg)
                except queue.Full:
                    stats["ws_dropped"] += 1
            else:
                log.warning(
                    f"Railway ingest drop after {max_retries} retries: {exc!r}"
                )
                stats["ws_dropped"] += 1

            # Reset broken keep-alive state after transport errors.
            try:
                session.close()
            except Exception:
                pass
            session = requests.Session()
        finally:
            _fwd_queue.task_done()


def _start_ws_thread() -> None:
    """Start the HTTP relay forwarding thread."""
    threading.Thread(target=_tick_batch_enqueue_loop, name="tick-forward-queue", daemon=True).start()
    t = threading.Thread(target=_http_relay_loop, name="http-relay", daemon=True)
    t.start()
    log.info("HTTP relay thread started")


def _push_history_to_railway() -> None:
    """
    One-shot: read all buffered 1m bars from candle_buffer and POST them
    to Railway /api/mt5/ingest as historical_bulk messages (one per conn_id).
    """
    if not RAILWAY_INGEST_URL:
        log.warning("push-history: RAILWAY_INGEST_URL not set")
        return

    headers: dict = {"Content-Type": "application/json"}
    if RAILWAY_TOKEN:
        headers["Authorization"] = f"Bearer {RAILWAY_TOKEN}"

    with _state_lock:
        snapshot = {cid: {sym: list(buf) for sym, buf in syms.items()}
                    for cid, syms in candle_buffer.items()}

    session = requests.Session()
    total_sent = 0
    for conn_id, sym_map in snapshot.items():
        if not sym_map:
            continue
        target_conn_id = RELAY_SOURCE_CONNECTION_ID or conn_id
        symbols_data = [
            {"symbol": sym, "bars": list(bars)}
            for sym, bars in sym_map.items() if bars
        ]
        if not symbols_data:
            continue
        total_bars = sum(len(e["bars"]) for e in symbols_data)
        payload = {
            "type":         "historical_bulk",
            "connection_id": target_conn_id,
            "symbols":      [e["symbol"] for e in symbols_data],
            "total_bars":   total_bars,
            "symbols_data": symbols_data,
        }
        try:
            resp = session.post(RAILWAY_INGEST_URL, json=payload, headers=headers, timeout=30)
            if resp.status_code < 300:
                total_sent += total_bars
                log.info(f"push-history: sent {len(symbols_data)} symbols / {total_bars} bars "
                         f"for conn {target_conn_id[:8]}")
            else:
                log.warning(f"push-history: Railway responded {resp.status_code}: {resp.text[:80]}")
        except Exception as exc:
            log.warning(f"push-history error: {exc!r}")


# ─── Candle buffer helpers ────────────────────────────────────────────────────

def _store_candle(conn_id: str, symbol: str, bar: dict) -> None:
    """Append a closed 1m bar. Thread-safe via lock."""
    with _state_lock:
        buf = candle_buffer[conn_id][symbol]
        # Avoid duplicates: don't add if last bar has same timestamp
        if buf and buf[-1]["t"] == bar["t"]:
            buf[-1] = bar  # update (e.g. retransmit with corrected data)
        else:
            buf.append(bar)


def _aggregate_tf(bars_1m: list, tf_minutes: int) -> list:
    """Aggregate a list of 1m OHLCV dicts into a larger TF."""
    if tf_minutes == 1:
        return list(bars_1m)
    slot_sec = tf_minutes * 60
    result: list[dict] = []
    for b in bars_1m:
        slot = (b["t"] // slot_sec) * slot_sec
        if result and result[-1]["t"] == slot:
            r = result[-1]
            r["h"] = max(r["h"], b["h"])
            r["l"] = min(r["l"], b["l"])
            r["c"] = b["c"]
            r["v"] += b["v"]
        else:
            result.append({"t": slot, "o": b["o"], "h": b["h"],
                           "l": b["l"], "c": b["c"], "v": b["v"]})
    return result


def _get_candles(conn_id: str, symbol: str, tf: str, count: int) -> list:
    """Return up to `count` bars for symbol/tf, oldest-first.

    Priority order:
      1. In-memory candle_buffer for the exact conn_id  (fastest — no IPC)
      2. In-memory candle_buffer from ANY conn_id that has the symbol
         (handles conn_id mismatch between browser and EA)
      3. MT5 IPC broker fetch  (slowest, requires terminal to be running)

    The "no synthetic candles" rule is preserved: all paths return
    broker-provided OHLCV data; we only aggregate 1m→higher-TF here.
    """
    tf_min = TF_MINUTES.get(tf, 1)
    broker_conn_id = _effective_conn_id(conn_id)

    def _fetch_broker() -> list:
        try:
            from runtime.mt5_candles import get_broker_candles
            return get_broker_candles(
                connection_id=broker_conn_id,
                symbol=symbol,
                timeframe=tf,
                count=count,
                include_current=True,
            )
        except Exception as exc:
            log.debug("_get_candles MT5 IPC fallback failed for %s/%s: %r", symbol, tf, exc)
            return []

    # ── Step 1: Buffer for exact conn_id ─────────────────────────────────────
    with _state_lock:
        exact = list(candle_buffer.get(conn_id, {}).get(symbol, []))

    best_agg: list = []
    if exact:
        best_agg = _aggregate_tf(exact, tf_min)

    # For higher timeframes, prefer the broker/terminal's own candles instead of
    # aggregating whatever 1m bars happen to be buffered after a relay restart.
    # This prevents cases where D1/H4 collapse to only a couple of visible bars
    # until enough fresh 1m data accumulates again.
    if tf_min > 1:
        broker = _fetch_broker()
        if len(broker) >= len(best_agg):
            return broker[-count:] if len(broker) > count else broker
        if best_agg:
            return best_agg[-count:] if len(best_agg) > count else best_agg

    # ── Step 2: Cross-conn buffer lookup ─────────────────────────────────────
    with _state_lock:
        best_bars: list = []
        for cid, sym_map in candle_buffer.items():
            bars = list(sym_map.get(symbol, []))
            if len(bars) > len(best_bars):
                best_bars = bars

    if best_bars:
        agg = _aggregate_tf(best_bars, tf_min)
        if len(agg) > len(best_agg):
            best_agg = agg

    if best_agg and len(best_agg) >= count:
        return best_agg[-count:] if len(best_agg) > count else best_agg

    # ── Step 3: MT5 IPC broker fetch (terminal must be running) ──────────────
    broker = _fetch_broker()
    if len(broker) >= len(best_agg):
        return broker[-count:] if len(broker) > count else broker
    return best_agg[-count:] if len(best_agg) > count else best_agg


# ─── HMAC verification ────────────────────────────────────────────────────────

def _verify_hmac(path: str, headers, body: bytes) -> bool:
    """Returns True if signature is valid (or RELAY_SECRET is blank = skip)."""
    if not RELAY_SECRET:
        return True
    ts        = headers.get("X-IFX-TS", "")
    nonce     = headers.get("X-IFX-NONCE", "")
    signature = headers.get("X-IFX-SIGNATURE", "")
    body_hash = hashlib.sha256(body).hexdigest().upper()
    string_to_sign = f"POST\n{path}\n{ts}\n{nonce}\n{body_hash}"
    expected = hmac.new(
        RELAY_SECRET.encode(),
        string_to_sign.encode(),
        hashlib.sha256,
    ).hexdigest().upper()
    return signature.upper() == expected


# ─── HTTP server ──────────────────────────────────────────────────────────────

class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # required for MT5 WebRequest POST

    def log_message(self, fmt, *args):
        pass  # suppress default Apache-style log

    # ── GET ───────────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        qs     = parse_qs(parsed.query)

        if path == "/config":
            self._handle_config()

        elif path == "/candles":
            self._handle_get_candles(qs)

        elif path == "/prices":
            self._handle_get_prices(qs)

        elif path == "/symbol-spec":
            self._handle_get_symbol_spec(qs)

        elif path == "/debug/mt5_status":
            self._handle_debug_mt5_status(qs)

        elif path == "/health":
            uptime = time.time() - stats["t_start"]
            body = json.dumps({
                "status":         "ok",
                "uptime_s":       round(uptime, 1),
                "tick_batches":   stats["tick_batches"],
                "candle_closes":  stats["candle_closes"],
                "ws_sent":        stats["ws_sent"],
                "ws_dropped":     stats["ws_dropped"],
                "railway_ingest": RAILWAY_INGEST_URL or "not configured",
                "relay_source_connection_id": RELAY_SOURCE_CONNECTION_ID or None,
                "active_conn_ids": list(latest_price.keys()),
                "sse_clients": len(_sse_clients),
                "candle_buf_syms": sum(
                    len(syms) for syms in candle_buffer.values()
                ),
                "setups": _setup_manager.summary() if _setup_manager else None,
            }).encode()
            self._send(200, body)

        elif path == "/push-history":
            # Re-push all buffered candle history to Railway ingest
            threading.Thread(target=_push_history_to_railway, daemon=True).start()
            body = json.dumps({"ok": True, "msg": "push started"}).encode()
            self._send(200, body)

        elif path == "/stream":
            self._handle_sse_stream(qs)

        else:
            self._send(404, b'{"error":"not found"}')

    def do_OPTIONS(self):
        # CORS preflight support (browser -> localhost relay)
        self._send(204, b"")

    def _handle_debug_mt5_status(self, qs: dict) -> None:
        """GET /debug/mt5_status?conn_id=...&symbol=...&tf=...&token=...

        For safety:
          - if IFX_DEBUG_TOKEN is set, require ?token=...
          - else only allow localhost.
        """
        debug_token = (os.getenv("IFX_DEBUG_TOKEN") or "").strip()
        token = (qs.get("token", [""])[0]).strip()
        remote_ip = (self.client_address[0] or "").strip()
        if debug_token:
            if token != debug_token:
                self._send(403, b'{"error":"forbidden"}')
                return
        else:
            if remote_ip not in {"127.0.0.1", "::1"}:
                self._send(403, b'{"error":"forbidden"}')
                return

        conn_id = (qs.get("conn_id", [""])[0]).strip()
        symbol = (qs.get("symbol", [""])[0]).strip()
        tf = (qs.get("tf", ["5m"])[0]).strip()

        if not conn_id:
            self._send(400, b'{"error":"conn_id required"}')
            return
        if not symbol:
            self._send(400, b'{"error":"symbol required"}')
            return
        if tf not in TF_MINUTES:
            self._send(400, json.dumps({"error": f"tf must be one of {list(TF_MINUTES)}"}).encode())
            return

        try:
            from runtime.mt5_candles import get_mt5_status

            payload = get_mt5_status(conn_id, symbol, tf)
            self._send(200, json.dumps(payload).encode())
        except Exception as exc:
            self._send(500, json.dumps({"error": repr(exc)}).encode())

    def _handle_config(self):
        stats["config_reqs"] += 1
        conn_id = self.headers.get("X-IFX-CONN-ID", "default")
        symbols = config_symbols.get(conn_id) or MOCK_SYMBOLS
        body = json.dumps({
            "symbols":      symbols,
            "count":        len(symbols),
            "connection_id": conn_id,
        }).encode()
        self._send(200, body)
        log.debug(f"[{conn_id[:8]}] GET /config → {len(symbols)} symbols")

    def _handle_get_candles(self, qs: dict):
        """GET /candles?symbol=BTCUSDm&tf=1h&count=200&conn_id=...

        Also accepts:
          - timeframe=<M1|H1|D1|1m|5m...>
          - limit=<int>

        This endpoint is frequently called from browsers; it must never crash
        the relay process on bad input or MT5 IPC errors.
        """

        def _first(key: str) -> str:
            return (qs.get(key, [""])[0] or "").strip()

        symbol = _first("symbol") or _first("sym")
        conn_id = _first("conn_id") or (self.headers.get("X-IFX-CONN-ID", "") or "").strip()

        tf_raw = _first("tf") or _first("timeframe") or "1m"
        tf_norm = (tf_raw or "").strip().lower()
        if tf_norm in {"m1", "m3", "m5", "m15", "m30"}:
            tf_norm = tf_norm[1:] + "m"
        elif tf_norm in {"h1", "h4"}:
            tf_norm = tf_norm[1:] + "h"
        elif tf_norm in {"d1"}:
            tf_norm = "1d"

        count_raw = _first("count") or _first("limit") or "200"
        try:
            count = int(count_raw)
        except Exception:
            count = 200
        count = max(1, min(count, 5000))

        if not symbol:
            self._send(400, b'{"error":"symbol required"}')
            return
        if not conn_id:
            self._send(400, b'{"error":"conn_id required"}')
            return
        if tf_norm not in TF_MINUTES:
            self._send(400, json.dumps({"error": f"tf must be one of {list(TF_MINUTES)}"}).encode())
            return

        try:
            bars = _get_candles(conn_id, symbol, tf_norm, count)
            body = json.dumps({"symbol": symbol, "tf": tf_norm, "count": len(bars), "bars": bars}).encode()
            self._send(200, body)
        except Exception as exc:
            log.warning(f"GET /candles error conn={conn_id[:8]} symbol={symbol} tf={tf_norm}: {exc!r}")
            body = json.dumps({"symbol": symbol, "tf": tf_norm, "count": 0, "bars": [], "error": repr(exc)}).encode()
            self._send(200, body)

    def _handle_get_prices(self, qs: dict):
        """GET /prices?conn_id=...  — latest bid/ask per symbol snapshot"""
        conn_id = (qs.get("conn_id", [""])[0]).strip()
        with _state_lock:
            if conn_id:
                prices = dict(latest_price.get(conn_id, {}))
            else:
                prices = {}
                for cid, syms in latest_price.items():
                    prices.update(syms)

        if conn_id:
            newest = _newest_price_ts_ms(prices)
            if not prices or (newest and (int(time.time() * 1000) - newest) > DIRECT_PRICE_MAX_AGE_MS):
                direct_prices = _refresh_direct_prices(conn_id)
                if direct_prices:
                    prices = dict(direct_prices)
        body = json.dumps({"prices": prices}).encode()
        self._send(200, body)

    def _handle_get_symbol_spec(self, qs: dict):
        """GET /symbol-spec?symbol=BTCUSDm&conn_id=... — broker sizing metadata."""
        symbol = (qs.get("symbol", [""])[0]).strip()
        conn_id = (qs.get("conn_id", [""])[0]).strip()

        if not symbol:
            self._send(400, b'{"error":"symbol required"}')
            return
        if not conn_id:
            self._send(400, b'{"error":"conn_id required"}')
            return

        try:
            from runtime.mt5_candles import get_symbol_trade_specs

            spec = get_symbol_trade_specs(conn_id, symbol)
            self._send(200, json.dumps(spec).encode())
        except Exception as exc:
            log.warning(f"GET /symbol-spec error conn={conn_id[:8]} symbol={symbol}: {exc!r}")
            self._send(200, json.dumps({"symbol": symbol, "error": repr(exc)}).encode())

    def _handle_sse_stream(self, qs: dict) -> None:
        """GET /stream  — Server-Sent Events price feed.

        The client (frontend) connects here and receives throttled price
        snapshots every SSE_INTERVAL_MS milliseconds without polling.
        No authentication needed – data is read-only market prices.
        """
        conn_id = ((qs.get("conn_id", [""])[0] or "").strip())

        self.send_response(200)
        origin = self.headers.get("Origin", "*")
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

        # Send initial snapshot so the UI fills instantly on connect
        try:
            with _state_lock:
                price_snapshot   = dict(latest_price.get(conn_id, {}))
                forming_snapshot = dict(forming.get(conn_id, {}))
                symbol_snapshot  = list(config_symbols.get(conn_id, []))
                if not symbol_snapshot:
                    symbol_snapshot = sorted(set(price_snapshot.keys()) | set(forming_snapshot.keys()))
            newest = _newest_price_ts_ms(price_snapshot)
            if conn_id and (not price_snapshot or (newest and (int(time.time() * 1000) - newest) > DIRECT_PRICE_MAX_AGE_MS)):
                direct_prices = _refresh_direct_prices(conn_id)
                if direct_prices:
                    price_snapshot = dict(direct_prices)
                    if not symbol_snapshot:
                        symbol_snapshot = sorted(set(price_snapshot.keys()) | set(forming_snapshot.keys()))
            if price_snapshot:
                init_msg = json.dumps({
                    "type": "init",
                    "connection_id": conn_id,
                    "symbols": symbol_snapshot,
                    "prices": price_snapshot,
                    "forming": forming_snapshot,
                })
                self.wfile.write(f"event: init\ndata: {init_msg}\n\n".encode())
            else:
                init_msg = json.dumps({
                    "type": "init",
                    "connection_id": conn_id,
                    "symbols": symbol_snapshot,
                    "prices": {},
                    "forming": forming_snapshot,
                })
                self.wfile.write(f"event: init\ndata: {init_msg}\n\n".encode())
            if forming_snapshot and not price_snapshot:
                forming_msg = json.dumps({
                    "type": "candle_update",
                    "connection_id": conn_id,
                    "forming": forming_snapshot,
                })
                self.wfile.write(f"event: candle_update\ndata: {forming_msg}\n\n".encode())
            connected_msg = json.dumps({
                "type": "connected",
                "connection_id": conn_id,
                "symbols": symbol_snapshot,
                "status": "ok",
            })
            self.wfile.write(f"event: connected\ndata: {connected_msg}\n\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

        client_q: queue.Queue = queue.Queue(maxsize=100)
        with _sse_lock:
            _sse_clients.append({"queue": client_q, "conn_id": conn_id})
        stats["sse_active"] = stats.get("sse_active", 0) + 1
        log.info(f"[SSE] client connected  conn_id={conn_id[:8]}  total={len(_sse_clients)}")

        try:
            last_direct_push = 0.0
            last_direct_snapshot = dict(price_snapshot)
            while True:
                try:
                    payload = client_q.get(timeout=1)
                    self.wfile.write(payload)
                    self.wfile.flush()
                except queue.Empty:
                    now = time.time()
                    pushed = False
                    if conn_id and now - last_direct_push >= DIRECT_PRICE_POLL_SECONDS:
                        direct_prices = _refresh_direct_prices(conn_id)
                        last_direct_push = now
                        if direct_prices and direct_prices != last_direct_snapshot:
                            msg = json.dumps({
                                "type": "prices",
                                "connection_id": conn_id,
                                "prices": direct_prices,
                            })
                            self.wfile.write(f"event: prices\ndata: {msg}\n\n".encode())
                            self.wfile.flush()
                            last_direct_snapshot = dict(direct_prices)
                            pushed = True
                    if not pushed:
                        # Keepalive comment — prevents proxy timeouts
                        self.wfile.write(b":\n\n")
                        self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _sse_lock:
                try:
                    for client in list(_sse_clients):
                        if client.get("queue") is client_q:
                            _sse_clients.remove(client)
                            break
                except ValueError:
                    pass
            stats["sse_active"] = max(0, stats.get("sse_active", 1) - 1)
            log.info(f"[SSE] client disconnected  total={len(_sse_clients)}")

    # ── POST ──────────────────────────────────────────────────────────────────

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length) if length else b""

        # HMAC verification
        if RELAY_SECRET and not _verify_hmac(path, self.headers, body):
            log.warning(f"HMAC mismatch on {path} from {self.headers.get('X-IFX-CONN-ID', '?')}")
            self._send(401, b'{"error":"invalid signature"}')
            return

        if path == "/tick-batch":
            self._handle_tick_batch(body)
        elif path == "/candle-close":
            self._handle_candle_close(body)
        elif path == "/historical-bulk":
            self._handle_historical_bulk(body)
        else:
            self._send(404, b'{"error":"unknown path"}')
            return

        self._send(200, b'{"ok":true}')

    def _handle_tick_batch(self, body: bytes):
        stats["tick_batches"] += 1
        try:
            data       = json.loads(body)
            raw_id     = data.get("connection_id", "default")
            conn_id    = _effective_conn_id(raw_id)   # remap if source lock active
            ticks      = data.get("ticks", [])
            candles    = data.get("forming_candles", [])

            stats["ticks_total"] += len(ticks)

            # Update latest price per symbol
            with _state_lock:
                for t in ticks:
                    sym = t.get("symbol")
                    if sym:
                        latest_price[conn_id][sym] = {
                            "bid":   t.get("bid"),
                            "ask":   t.get("ask"),
                            "ts_ms": t.get("ts_ms"),
                        }

                # Update forming candles
                for c in candles:
                    sym = c.get("symbol")
                    if sym:
                        forming[conn_id][sym] = {
                            "t": c.get("time"),
                            "o": c.get("open"),
                            "h": c.get("high"),
                            "l": c.get("low"),
                            "c": c.get("close"),
                            "v": c.get("tick_vol", 0),
                        }

            # Accumulate for SSE broadcaster (200ms throttle)
            with _pending_lock:
                bucket = _pending_broadcast.setdefault(conn_id, {})
                for t in ticks:
                    sym = t.get("symbol")
                    if sym:
                        bucket[sym] = {
                            "bid":   t.get("bid"),
                            "ask":   t.get("ask"),
                            "ts_ms": t.get("ts_ms"),
                        }
                # Accumulate forming candles for candle_update SSE events
                fbucket = _pending_forming.setdefault(conn_id, {})
                for c in candles:
                    sym = c.get("symbol")
                    if sym:
                        fbucket[sym] = {
                            "t": c.get("time"),
                            "o": c.get("open"),
                            "h": c.get("high"),
                            "l": c.get("low"),
                            "c": c.get("close"),
                            "v": c.get("tick_vol", 0),
                        }

            # Evaluate setup state machine on tick data
            _sm_on_tick_batch(conn_id, ticks)

            # Forward to Railway — use remapped conn_id so Railway stores under the right account
            enqueue_ws({
                "type":          "tick_batch",
                "connection_id": conn_id,
                "ts_ms":         data.get("ts_ms"),
                "ticks":         ticks,
                "forming_candles": candles,
            })

            if stats["tick_batches"] % 100 == 1:
                elapsed = time.time() - stats["t_start"]
                rate    = stats["ticks_total"] / elapsed if elapsed else 0
                log.info(
                    f"[tick-batch #{stats['tick_batches']}] "
                    f"ticks={len(ticks)} forming={len(candles)} "
                    f"rate={rate:.1f}/s ws_sent={stats['ws_sent']}"
                )

        except Exception as exc:
            log.error(f"tick-batch error: {exc}", exc_info=True)

    def _handle_candle_close(self, body: bytes):
        stats["candle_closes"] += 1
        try:
            data    = json.loads(body)
            raw_id  = data.get("connection_id", "default")
            conn_id = _effective_conn_id(raw_id)   # remap if source lock active
            symbol  = data.get("symbol", "")

            bar = {
                "t": data.get("time"),
                "o": data.get("open"),
                "h": data.get("high"),
                "l": data.get("low"),
                "c": data.get("close"),
                "v": data.get("tick_vol", 0),
            }
            _store_candle(conn_id, symbol, bar)

            log.info(
                f"[candle-close #{stats['candle_closes']}] "
                f"{symbol} t={bar['t']} "
                f"O={bar['o']} H={bar['h']} L={bar['l']} C={bar['c']} "
                f"buf={len(candle_buffer[conn_id][symbol])}"
            )

            # Evaluate setup state machine (H1 boundary detection inside)
            _sm_on_candle_close(conn_id, symbol, bar)

            # Broadcast to SSE clients (instant, no queue)
            _broadcast_sse_event({
                "type":          "candle_close",
                "connection_id": conn_id,
                "symbol":        symbol,
                "timeframe":     data.get("timeframe", "1m"),
                "bar":           bar,
            })

            # Forward to Railway WS
            enqueue_ws({
                "type":          "candle_close",
                "connection_id": conn_id,
                "symbol":        symbol,
                "timeframe":     data.get("timeframe", "1m"),
                "bar":           bar,
            })

        except Exception as exc:
            log.error(f"candle-close error: {exc}", exc_info=True)

    def _handle_historical_bulk(self, body: bytes):
        stats["historical_bulk"] += 1
        try:
            data    = json.loads(body)
            raw_id  = data.get("connection_id", "default")
            conn_id = _effective_conn_id(raw_id)   # remap if source lock active
            symbols = data.get("symbols", [])

            total_bars = 0
            sym_names  = []
            for sym_entry in symbols:
                sym  = sym_entry.get("symbol", "")
                bars = sym_entry.get("bars", [])
                sym_names.append(sym)
                total_bars += len(bars)

                # Store bars in the ring buffer — merge-insert inside the loop (one sym at a time)
                with _state_lock:
                    buf = candle_buffer[conn_id][sym]
                    existing_ts = {b["t"] for b in buf}
                    # Insert bars that are not already present (avoid dupes)
                    for b in bars:
                        bar = {"t": b["t"], "o": b["o"], "h": b["h"],
                               "l": b["l"], "c": b["c"], "v": b.get("v", 0)}
                        if bar["t"] not in existing_ts:
                            existing_ts.add(bar["t"])
                            buf.append(bar)
                    # Re-sort the deque by time (historical arrives mixed with live)
                    sorted_bars = sorted(buf, key=lambda x: x["t"])
                    buf.clear()
                    for b in sorted_bars:
                        buf.append(b)

            # Register symbols for this connection
            if sym_names:
                config_symbols[conn_id] = sym_names

            log.info(
                f"[historical-bulk #{stats['historical_bulk']}] "
                f"{len(symbols)} symbols  total_bars={total_bars}  "
                f"bars_req={data.get('bars_requested')}"
            )

            # Forward to Railway — include full bar data so Railway can seed its buffer
            enqueue_ws({
                "type":           "historical_bulk",
                "connection_id":  conn_id,
                "symbols":        sym_names,
                "total_bars":     total_bars,
                "bars_requested": data.get("bars_requested"),
                "symbols_data":   [
                    {
                        "symbol": s.get("symbol"),
                        "bars":   s.get("bars", []),
                    }
                    for s in symbols
                ],
            })

        except Exception as exc:
            log.error(f"historical-bulk error: {exc}", exc_info=True)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _send(self, code: int, body: bytes):
        self.send_response(code)
        # CORS: allow a web UI to call the localhost relay directly.
        # Relay only binds to 127.0.0.1, so it's not remotely reachable.
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-IFX-TS, X-IFX-NONCE, X-IFX-SIGNATURE, X-IFX-CONN-ID",
        )
        self.send_header("Access-Control-Max-Age", "600")

        if body:
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
        else:
            self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        if body:
            self.wfile.write(body)


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    expected_venv_python = _WORKSPACE_ROOT / ".venv" / "Scripts" / "python.exe"
    venv_root = _WORKSPACE_ROOT / ".venv"
    if expected_venv_python.exists() and venv_root.exists():
        expected_exe = os.path.normcase(os.path.abspath(str(expected_venv_python)))
        actual_exe = os.path.normcase(os.path.abspath(str(getattr(sys, "executable", ""))))
        if expected_exe and actual_exe and actual_exe != expected_exe:
            log.error(
                "Refusing to run with non-venv Python executable. "
                f"Expected sys.executable={expected_exe} | Got sys.executable={actual_exe}"
            )
            log.error(f"Run with: {expected_venv_python} runtime/price_relay.py")
            sys.exit(2)

        expected_prefix = os.path.normcase(os.path.abspath(str(venv_root)))
        actual_prefix = os.path.normcase(os.path.abspath(str(getattr(sys, "prefix", ""))))
        if expected_prefix and actual_prefix and actual_prefix != expected_prefix:
            log.error(
                "Refusing to run outside the workspace venv. "
                f"Expected sys.prefix={expected_prefix} | Got sys.prefix={actual_prefix}"
            )
            log.error(f"Run with: {expected_venv_python} runtime/price_relay.py")
            sys.exit(2)

    # Ensure we don't have an old system-Python relay competing on the port.
    _kill_non_venv_relay_duplicates()
    _acquire_single_instance_lock()

    log.info("=" * 60)
    log.info("  IFX Price Bridge -- Production Relay  (Sprint 3)")
    log.info(f"  Listening on http://127.0.0.1:{PORT}")
    log.info(f"  HMAC verification: {'ON' if RELAY_SECRET else 'OFF (RELAY_SECRET not set)'}")
    log.info(f"  Railway ingest: {RAILWAY_INGEST_URL or 'NOT CONFIGURED -- buffer only'}")
    if RELAY_SOURCE_CONNECTION_ID:
        log.info(f"  Relay source lock: {RELAY_SOURCE_CONNECTION_ID}")
    else:
        log.info("  Relay source lock: OFF (all connection IDs accepted)")
    log.info(f"  Candle buffer: {CANDLE_MAXBARS} bars/symbol (~{CANDLE_MAXBARS//60}h of 1m)")
    log.info("=" * 60)

    # Restore candle buffer from disk (survives relay restarts)
    load_buffer()

    # Start WebSocket relay thread (handles both connected and disconnected states)
    _start_ws_thread()

    # Start SSE broadcaster (throttled, pushes price snapshots to browser clients)
    threading.Thread(target=_sse_broadcaster_loop, name="sse-broadcast", daemon=True).start()
    log.info(f"SSE broadcaster started  interval={int(SSE_INTERVAL_S*1000)}ms")

    threading.Thread(target=_direct_price_forward_loop, name="direct-price-forward", daemon=True).start()
    log.info(f"Direct price forwarder started  interval={DIRECT_PRICE_POLL_SECONDS:.1f}s")

    if _setup_manager is not None and _sm_event_queue is not None:
        threading.Thread(target=_setup_event_loop, name="setup-events", daemon=True).start()
        log.info("Setup event worker started")

    # Start autosave thread
    threading.Thread(target=_buffer_autosave_loop, name="autosave", daemon=True).start()

    # After a delay, push all buffered history to Railway (gives EA time to reconnect)
    if RAILWAY_INGEST_URL:
        def _delayed_push():
            time.sleep(45)
            log.info("Auto push-history -> Railway on startup")
            _push_history_to_railway()
        threading.Thread(target=_delayed_push, name="auto-push", daemon=True).start()

        def _railway_watchdog_loop():
            """Every 60s, check if Railway dropped its state (redeploy). Re-push if so."""
            time.sleep(30)  # skip first 30s (startup push already queued)
            while True:
                try:
                    import urllib.request as _ureq
                    url = RAILWAY_INGEST_URL.replace("/api/mt5/ingest", "/api/candles?symbol=BTCUSDm&tf=1m&count=1")
                    req = _ureq.Request(url, headers={"Accept": "application/json"})
                    with _ureq.urlopen(req, timeout=8) as resp:
                        data = json.loads(resp.read().decode())
                    count = data.get("count", 0)
                    if count < 5:
                        log.info(f"[watchdog] Railway has only {count} BTC bars → re-pushing history")
                        _push_history_to_railway()
                    else:
                        log.debug(f"[watchdog] Railway OK ({count} BTC bars)")
                except Exception as exc:
                    log.debug(f"[watchdog] check failed: {exc!r}")
                time.sleep(60)  # check every 60 seconds
        threading.Thread(target=_railway_watchdog_loop, name="watchdog", daemon=True).start()

    # Start HTTP server (blocks)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), RelayHandler)
    log.info(f"HTTP server ready — waiting for EA connections on port {PORT}")
    log.info("Endpoints:")
    log.info("  GET  /config                      — symbol list")
    log.info("  GET  /candles?symbol=X&tf=1h&count=200&conn_id=... — broker candles (MT5)")
    log.info("  GET  /prices                      — latest bid/ask snapshot")
    log.info("  GET  /health                      — stats")
    log.info("  POST /tick-batch                  — live ticks + forming candles")
    log.info("  POST /candle-close                — completed bar")
    log.info("  POST /historical-bulk             — init history dump")
    log.info("  GET  /stream                      — SSE live price feed (Cloudflare Tunnel)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        elapsed = time.time() - stats["t_start"]
        log.info("")
        log.info("Session summary:")
        log.info(f"  Duration:        {elapsed:.0f}s")
        log.info(f"  Tick batches:    {stats['tick_batches']}")
        log.info(f"  Total ticks:     {stats['ticks_total']}")
        log.info(f"  Candle closes:   {stats['candle_closes']}")
        log.info(f"  Historical bulk: {stats['historical_bulk']}")
        log.info(f"  WS sent:         {stats['ws_sent']}")
        log.info(f"  WS dropped:      {stats['ws_dropped']}")
        save_buffer()
        server.server_close()


if __name__ == "__main__":
    main()
