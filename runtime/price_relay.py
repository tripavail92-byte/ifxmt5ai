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

_fwd_queue: queue.Queue = queue.Queue(maxsize=2000)


def enqueue_fwd(msg: dict) -> None:
    """Thread-safe: enqueue a message for forwarding to Railway ingest."""
    if not RAILWAY_INGEST_URL:
        return  # buffering only — no Railway endpoint configured
    try:
        if "_retry" not in msg:
            msg["_retry"] = 0
        _fwd_queue.put_nowait(msg)
    except queue.Full:
        stats["ws_dropped"] += 1


# Keep the old name as alias so existing call sites don't need changing
enqueue_ws = enqueue_fwd


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
        symbols_data = [
            {"symbol": sym, "bars": list(bars)}
            for sym, bars in sym_map.items() if bars
        ]
        if not symbols_data:
            continue
        total_bars = sum(len(e["bars"]) for e in symbols_data)
        payload = {
            "type":         "historical_bulk",
            "connection_id": conn_id,
            "symbols":      [e["symbol"] for e in symbols_data],
            "total_bars":   total_bars,
            "symbols_data": symbols_data,
        }
        try:
            resp = session.post(RAILWAY_INGEST_URL, json=payload, headers=headers, timeout=30)
            if resp.status_code < 300:
                total_sent += total_bars
                log.info(f"push-history: sent {len(symbols_data)} symbols / {total_bars} bars "
                         f"for conn {conn_id[:8]}")
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

    # ── Step 1: Buffer for exact conn_id ─────────────────────────────────────
    with _state_lock:
        exact = list(candle_buffer.get(conn_id, {}).get(symbol, []))

    if exact:
        agg = _aggregate_tf(exact, tf_min)
        return agg[-count:] if len(agg) > count else agg

    # ── Step 2: Cross-conn buffer lookup ─────────────────────────────────────
    with _state_lock:
        best_bars: list = []
        for cid, sym_map in candle_buffer.items():
            bars = list(sym_map.get(symbol, []))
            if len(bars) > len(best_bars):
                best_bars = bars

    if best_bars:
        agg = _aggregate_tf(best_bars, tf_min)
        return agg[-count:] if len(agg) > count else agg

    # ── Step 3: MT5 IPC broker fetch (terminal must be running) ──────────────
    try:
        from runtime.mt5_candles import get_broker_candles
        return get_broker_candles(
            connection_id=conn_id,
            symbol=symbol,
            timeframe=tf,
            count=count,
            include_current=True,
        )
    except Exception as exc:
        log.debug("_get_candles MT5 IPC fallback failed for %s/%s: %r", symbol, tf, exc)
        return []


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
        body = json.dumps({"prices": prices}).encode()
        self._send(200, body)

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
            data    = json.loads(body)
            conn_id = data.get("connection_id", "default")
            ticks   = data.get("ticks", [])
            candles = data.get("forming_candles", [])

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

            # Evaluate setup state machine on tick data
            _sm_on_tick_batch(conn_id, ticks)

            # Forward to Railway WS
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
            conn_id = data.get("connection_id", "default")
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
            conn_id = data.get("connection_id", "default")
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
    log.info(f"  Candle buffer: {CANDLE_MAXBARS} bars/symbol (~{CANDLE_MAXBARS//60}h of 1m)")
    log.info("=" * 60)

    # Restore candle buffer from disk (survives relay restarts)
    load_buffer()

    # Start WebSocket relay thread (handles both connected and disconnected states)
    _start_ws_thread()

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
