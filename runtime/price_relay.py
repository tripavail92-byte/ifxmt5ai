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

import asyncio
import collections
import hashlib
import hmac
import json
import logging
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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

PORT             = int(os.getenv("RELAY_PORT", "8082"))
RELAY_SECRET     = os.getenv("RELAY_SECRET", "")          # blank = skip HMAC verify
RAILWAY_WS_URL   = os.getenv("RAILWAY_WS_URL", "")        # blank = buffer only, no forward
RAILWAY_TOKEN    = os.getenv("RAILWAY_RELAY_TOKEN", "")   # Bearer token for Railway WS
CANDLE_MAXBARS   = int(os.getenv("RELAY_CANDLE_MAXBARS", "1500"))  # ~25h of 1m data

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

# ─── WebSocket forwarder ──────────────────────────────────────────────────────
#
#  Runs in a dedicated daemon thread with its own asyncio event loop.
#  HTTP handlers call enqueue_ws(msg_dict) which is thread-safe.
#  When RAILWAY_WS_URL is blank the queue simply drains to /dev/null.

_ws_loop:  asyncio.AbstractEventLoop | None = None
_ws_queue: asyncio.Queue | None            = None


def enqueue_ws(msg: dict) -> None:
    """Thread-safe: submit a message to the WS relay queue."""
    if _ws_loop is None or _ws_queue is None:
        return
    if not RAILWAY_WS_URL:
        return  # no Railway endpoint configured — skip forwarding

    try:
        _ws_loop.call_soon_threadsafe(_ws_queue.put_nowait, json.dumps(msg))
    except asyncio.QueueFull:
        stats["ws_dropped"] += 1


async def _ws_relay_loop() -> None:
    """Persistent WebSocket client to Railway with exponential backoff reconnect."""
    global _ws_queue
    _ws_queue = asyncio.Queue(maxsize=1000)

    if not RAILWAY_WS_URL:
        log.info("RAILWAY_WS_URL not set — WS forwarding disabled, buffering only")
        # Keep queue alive so enqueue_ws() calls don't crash; drain silently
        while True:
            await _ws_queue.get()

    import websockets  # imported here to keep startup fast if WS not needed

    headers = {}
    if RAILWAY_TOKEN:
        headers["Authorization"] = f"Bearer {RAILWAY_TOKEN}"

    backoff = 1.0
    while True:
        try:
            log.info(f"WS → connecting to {RAILWAY_WS_URL} ...")
            async with websockets.connect(
                RAILWAY_WS_URL,
                additional_headers=headers,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=15,
            ) as ws:
                log.info("WS → connected to Railway ✅")
                backoff = 1.0  # reset on success

                # Send all queued messages
                while True:
                    msg_str = await _ws_queue.get()
                    await ws.send(msg_str)
                    stats["ws_sent"] += 1

        except Exception as exc:
            log.warning(f"WS error: {exc!r}  — retry in {backoff:.0f}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2.0, 60.0)


def _start_ws_thread() -> None:
    global _ws_loop
    _ws_loop = asyncio.new_event_loop()

    def run():
        _ws_loop.run_until_complete(_ws_relay_loop())

    t = threading.Thread(target=run, name="ws-relay", daemon=True)
    t.start()
    log.info("WS relay thread started")


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
                "railway_ws":     RAILWAY_WS_URL or "not configured",
                "candle_buf_syms": sum(
                    len(syms) for syms in candle_buffer.values()
                ),
            }).encode()
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

                # Store all bars in the ring buffer
                # EA sends oldest-first so we can append in order
                with _state_lock:
                    buf = candle_buffer[conn_id][sym]
                    for b in bars:
                        bar = {"t": b["t"], "o": b["o"], "h": b["h"],
                               "l": b["l"], "c": b["c"], "v": b.get("v", 0)}
                        if not buf or buf[-1]["t"] < bar["t"]:
                            buf.append(bar)
                        elif buf[-1]["t"] == bar["t"]:
                            buf[-1] = bar  # update if same timestamp

            # Register symbols for this connection
            if sym_names:
                config_symbols[conn_id] = sym_names

            log.info(
                f"[historical-bulk #{stats['historical_bulk']}] "
                f"{len(symbols)} symbols  total_bars={total_bars}  "
                f"bars_req={data.get('bars_requested')}"
            )

            # Forward to Railway WS (abbreviated — just notify without full payload)
            enqueue_ws({
                "type":          "historical_bulk",
                "connection_id": conn_id,
                "symbols":       sym_names,
                "total_bars":    total_bars,
                "bars_requested": data.get("bars_requested"),
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
    log.info("=" * 60)
    log.info("  IFX Price Bridge — Production Relay  (Sprint 3)")
    log.info(f"  Listening on http://127.0.0.1:{PORT}")
    log.info(f"  HMAC verification: {'ON' if RELAY_SECRET else 'OFF (RELAY_SECRET not set)'}")
    log.info(f"  Railway WS: {RAILWAY_WS_URL or 'NOT CONFIGURED — buffer only'}")
    log.info(f"  Candle buffer: {CANDLE_MAXBARS} bars/symbol (~{CANDLE_MAXBARS//60}h of 1m)")
    log.info("=" * 60)

    # Start WebSocket relay thread (handles both connected and disconnected states)
    _start_ws_thread()

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
        server.server_close()


if __name__ == "__main__":
    main()
