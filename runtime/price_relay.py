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

# ─── Setup state machine (optional — no-op if Supabase not configured) ─────────
try:
    import os as _os, sys as _sys
    _root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    from ai_engine.setup_manager import setup_manager as _setup_manager
    log_setup = logging.getLogger("setup_manager")
    log_setup.info("setup_manager imported OK")
except Exception as _sm_err:
    _setup_manager = None
    logging.getLogger("setup_manager").warning(
        "setup_manager not available: %r — state machine disabled", _sm_err
    )


def _sm_on_tick_batch(conn_id: str, ticks: list) -> None:
    if _setup_manager is not None:
        try:
            _setup_manager.on_tick_batch(conn_id, ticks)
        except Exception as _e:
            log.debug("setup_manager.on_tick_batch error: %r", _e)


def _sm_on_candle_close(conn_id: str, symbol: str, bar: dict) -> None:
    if _setup_manager is not None:
        try:
            _setup_manager.on_candle_close(conn_id, symbol, bar)
        except Exception as _e:
            log.debug("setup_manager.on_candle_close error: %r", _e)


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

PORT             = int(os.getenv("RELAY_PORT", "8082"))
RELAY_SECRET     = os.getenv("RELAY_SECRET", "")              # blank = skip HMAC verify
RAILWAY_INGEST_URL = os.getenv("RAILWAY_INGEST_URL", "")      # https://....railway.app/api/mt5/ingest
RAILWAY_TOKEN    = os.getenv("RAILWAY_RELAY_TOKEN", "")       # Bearer token for Railway ingest
# Default to ~7 days of 1m data per symbol (override via RELAY_CANDLE_MAXBARS)
CANDLE_MAXBARS   = int(os.getenv("RELAY_CANDLE_MAXBARS", "10000"))

# Timeframe aggregation map  {tf_label -> minutes}
TF_MINUTES = {
    "1m":  1,
    "5m":  5,
    "15m": 15,
    "1h":  60,
    "4h":  240,
    "1d":  1440,
}

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

def save_buffer() -> None:
    """Persist candle_buffer to disk (called every 60s + on shutdown)."""
    try:
        with _state_lock:
            data = {cid: {sym: list(buf) for sym, buf in syms.items()}
                    for cid, syms in candle_buffer.items() if syms}
        with open(BUFFER_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as exc:
        log.warning(f"save_buffer error: {exc!r}")

def load_buffer() -> None:
    """Restore candle_buffer from disk on startup."""
    if not BUFFER_FILE.exists():
        return
    try:
        with open(BUFFER_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        with _state_lock:
            for cid, sym_map in data.items():
                for sym, bars in sym_map.items():
                    buf = candle_buffer[cid][sym]
                    for b in bars:
                        buf.append(b)
        total = sum(len(s) for c in data.values() for s in c.values())
        log.info(f"Loaded {total} bars from disk for {sum(len(v) for v in data.values())} symbols")
    except Exception as exc:
        log.warning(f"load_buffer error: {exc!r}")

def _buffer_autosave_loop() -> None:
    """Background thread: save buffer to disk every 60 seconds."""
    while True:
        time.sleep(60)
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

    headers: dict = {"Content-Type": "application/json"}
    if RAILWAY_TOKEN:
        headers["Authorization"] = f"Bearer {RAILWAY_TOKEN}"

    session = requests.Session()
    backoff = 1.0
    log.info(f"HTTP relay -> target: {RAILWAY_INGEST_URL}")

    while True:
        msg = _fwd_queue.get()
        try:
            resp = session.post(
                RAILWAY_INGEST_URL,
                data=json.dumps(msg),
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
            log.warning(f"Railway ingest error: {exc!r} - retry in {backoff:.0f}s")
            stats["ws_dropped"] += 1
            time.sleep(backoff)
            backoff = min(backoff * 2.0, 30.0)
            # Re-enqueue the failed message (best-effort)
            try:
                _fwd_queue.put_nowait(msg)
            except queue.Full:
                pass
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
    """Return up to `count` closed bars for symbol/tf, oldest-first."""
    tf_min = TF_MINUTES.get(tf, 1)
    with _state_lock:
        bars_1m = list(candle_buffer[conn_id][symbol])  # snapshot

    aggregated = _aggregate_tf(bars_1m, tf_min)
    return aggregated[-count:] if count < len(aggregated) else aggregated


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
        """GET /candles?symbol=BTCUSDm&tf=1h&count=200&conn_id=..."""
        symbol  = (qs.get("symbol",  [""])[0]).strip()
        tf      = (qs.get("tf",      ["1m"])[0]).strip()
        count   = int(qs.get("count", ["200"])[0])
        conn_id = (qs.get("conn_id", [""])[0]).strip()

        if not symbol:
            self._send(400, b'{"error":"symbol required"}')
            return
        if tf not in TF_MINUTES:
            self._send(400, json.dumps({"error": f"tf must be one of {list(TF_MINUTES)}"}).encode())
            return

        # If conn_id not specified, search all connections for this symbol
        if not conn_id:
            for cid in candle_buffer:
                if symbol in candle_buffer[cid]:
                    conn_id = cid
                    break

        bars = _get_candles(conn_id, symbol, tf, count)

        # Append current forming candle if available
        with _state_lock:
            fc = forming.get(conn_id, {}).get(symbol)
        if fc:
            tf_min  = TF_MINUTES[tf]
            slot_sec = tf_min * 60
            fc_slot = (fc["t"] // slot_sec) * slot_sec
            if not bars or bars[-1]["t"] != fc_slot:
                bars = bars + [{"t": fc_slot, "o": fc["o"], "h": fc["h"],
                                "l": fc["l"], "c": fc["c"], "v": fc.get("v", 0)}]

        body = json.dumps({"symbol": symbol, "tf": tf, "count": len(bars), "bars": bars}).encode()
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
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    expected_venv_python = _WORKSPACE_ROOT / ".venv" / "Scripts" / "python.exe"
    try:
        exe_path = Path(sys.executable).resolve()
    except Exception:
        exe_path = Path(sys.executable)

    if expected_venv_python.exists():
        try:
            expected_path = expected_venv_python.resolve()
        except Exception:
            expected_path = expected_venv_python

        if exe_path != expected_path:
            log.error(
                "Refusing to run with non-venv Python. "
                f"Expected: {expected_path} | Got: {exe_path}"
            )
            log.error(f"Run with: {expected_path} runtime/price_relay.py")
            sys.exit(2)

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
    log.info("  GET  /candles?symbol=X&tf=1h&count=200 — buffered candles")
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
