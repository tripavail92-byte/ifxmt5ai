#!/usr/bin/env python3
"""
IFX Price Bridge — localhost echo server for EA testing (T15)
Run this BEFORE attaching the EA to a chart.

Usage:
    python relay_echo.py

Tests:
    - EA can reach localhost:8082
    - HMAC signature arrives and looks correct
    - /config returns symbol list
    - /tick-batch payloads arrive with ticks + forming_candles
    - /candle-close payloads arrive on bar close
    - /historical-bulk arrives on OnInit

Press Ctrl+C to stop.
"""

import json
import hashlib
import hmac
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ── Config ────────────────────────────────────────────────────────────────────

PORT            = 8082
SIGNING_SECRET  = ""          # Leave blank to skip HMAC verification in echo mode
LOG_TICKS       = False        # Set True to print every tick (can be noisy)

MOCK_SYMBOLS = [
    "EURUSDm", "GBPUSDm", "USDJPYm", "USDCADm", "AUDUSDm",
    "NZDUSDm", "USDCHFm", "EURGBPm", "XAUUSDm", "BTCUSDm",
    "ETHUSDm", "USOILm"
]

# ── Stats ─────────────────────────────────────────────────────────────────────

stats = {
    "tick_batches":    0,
    "ticks_total":     0,
    "candle_closes":   0,
    "historical_bulk": 0,
    "config_requests": 0,
    "t_start":         time.time(),
}

# ── Request handler ───────────────────────────────────────────────────────────

class EchoHandler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # suppress default Apache-style log; we do our own

    # ── GET /config ───────────────────────────────────────────────────────────
    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/config":
            stats["config_requests"] += 1
            body = json.dumps({
                "symbols":     MOCK_SYMBOLS,
                "count":       len(MOCK_SYMBOLS),
                "connection_id": "test",
            }).encode()
            self._send(200, body)
            print(f"  [CONFIG] /config → returned {len(MOCK_SYMBOLS)} symbols")
            return

        if path == "/health":
            self._send(200, b'{"status":"ok"}')
            return

        self._send(404, b'{"error":"not found"}')

    # ── POST handlers ─────────────────────────────────────────────────────────
    def do_POST(self):
        path   = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body   = self.rfile.read(length) if length else b""

        # Parse HMAC headers (log but don't reject in echo mode)
        conn_id   = self.headers.get("X-IFX-CONN-ID", "")
        ts        = self.headers.get("X-IFX-TS", "")
        nonce     = self.headers.get("X-IFX-NONCE", "")
        signature = self.headers.get("X-IFX-SIGNATURE", "")

        if SIGNING_SECRET and body:
            body_hash      = hashlib.sha256(body).hexdigest().upper()
            string_to_sign = f"POST\n{path}\n{ts}\n{nonce}\n{body_hash}"
            expected_sig   = hmac.new(
                SIGNING_SECRET.encode(),
                string_to_sign.encode(),
                hashlib.sha256
            ).hexdigest().upper()
            if signature.upper() != expected_sig:
                print(f"  ⚠️  HMAC MISMATCH on {path}")

        # Route
        if path == "/tick-batch":
            self._handle_tick_batch(body)
        elif path == "/candle-close":
            self._handle_candle_close(body)
        elif path == "/historical-bulk":
            self._handle_historical_bulk(body)
        else:
            print(f"  ❓ Unknown POST: {path}")
            self._send(404, b'{"error":"unknown path"}')
            return

        self._send(200, b'{"ok":true}')

    # ── Handlers ──────────────────────────────────────────────────────────────

    def _handle_tick_batch(self, body: bytes):
        stats["tick_batches"] += 1
        try:
            data   = json.loads(body)
            ticks  = data.get("ticks",           [])
            candles= data.get("forming_candles", [])
            stats["ticks_total"] += len(ticks)

            elapsed = time.time() - stats["t_start"]
            rate    = stats["ticks_total"] / elapsed if elapsed > 0 else 0

            if LOG_TICKS or stats["tick_batches"] % 20 == 1:
                print(
                    f"  [TICK-BATCH #{stats['tick_batches']:5d}] "
                    f"ticks={len(ticks):3d}  forming={len(candles):2d}  "
                    f"total_ticks={stats['ticks_total']:6d}  "
                    f"rate={rate:.1f}/s  "
                    f"conn={data.get('connection_id','?')[:8]}"
                )

                # Print a sample tick
                if ticks:
                    t = ticks[0]
                    print(f"       sample → {t.get('symbol')} "
                          f"bid={t.get('bid')} ask={t.get('ask')}")

                # Print forming candles
                for c in candles[:3]:
                    print(f"       forming → {c.get('symbol')} "
                          f"O={c.get('open')} H={c.get('high')} "
                          f"L={c.get('low')} C={c.get('close')}")

        except Exception as exc:
            print(f"  ❌ tick-batch parse error: {exc}")

    def _handle_candle_close(self, body: bytes):
        stats["candle_closes"] += 1
        try:
            data = json.loads(body)
            print(
                f"  🕐 [CANDLE-CLOSE #{stats['candle_closes']}] "
                f"{data.get('symbol')} @ {data.get('time')}  "
                f"O={data.get('open')} H={data.get('high')} "
                f"L={data.get('low')} C={data.get('close')} "
                f"vol={data.get('tick_vol')}"
            )
        except Exception as exc:
            print(f"  ❌ candle-close parse error: {exc}")

    def _handle_historical_bulk(self, body: bytes):
        stats["historical_bulk"] += 1
        try:
            data      = json.loads(body)
            symbols   = data.get("symbols", [])
            sym_count = len(symbols)

            total_bars = sum(len(s.get("bars", [])) for s in symbols)

            print(
                f"  📦 [HISTORICAL-BULK #{stats['historical_bulk']}] "
                f"{sym_count} symbols  total_bars={total_bars}  "
                f"bars_requested={data.get('bars_requested')}"
            )
            for s in symbols:
                bars = s.get("bars", [])
                print(f"       {s.get('symbol'):12s}  {len(bars)} bars", end="")
                if bars:
                    first = bars[0]
                    last  = bars[-1]
                    print(f"  first_t={first.get('t')}  last_t={last.get('t')}", end="")
                print()
        except Exception as exc:
            print(f"  ❌ historical-bulk parse error: {exc}")

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _send(self, code: int, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print(f"  IFX Price Bridge — Echo Server")
    print(f"  Listening on http://localhost:{PORT}")
    print(f"  Mock symbols: {len(MOCK_SYMBOLS)}")
    print(f"  HMAC verification: {'ON (' + SIGNING_SECRET[:8] + '...)' if SIGNING_SECRET else 'OFF (echo mode)'}")
    print("=" * 60)
    print()
    print("  Expected requests from EA:")
    print("    GET  /config           — on OnInit and every 60s")
    print("    POST /historical-bulk  — on OnInit (500 bars × all symbols)")
    print("    POST /tick-batch       — every 150ms while market open")
    print("    POST /candle-close     — once per 1m bar close per symbol")
    print()
    print("  Press Ctrl+C to stop.")
    print()

    server = HTTPServer(("localhost", PORT), EchoHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        elapsed = time.time() - stats["t_start"]
        print()
        print("=" * 60)
        print("  Session summary:")
        print(f"    Duration:        {elapsed:.0f}s")
        print(f"    Config requests: {stats['config_requests']}")
        print(f"    Historical bulk: {stats['historical_bulk']}")
        print(f"    Tick batches:    {stats['tick_batches']}")
        print(f"    Total ticks:     {stats['ticks_total']}")
        print(f"    Candle closes:   {stats['candle_closes']}")
        if elapsed > 0:
            print(f"    Avg tick rate:   {stats['ticks_total']/elapsed:.1f}/s")
        print("=" * 60)
        server.server_close()
