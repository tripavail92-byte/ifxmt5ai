#!/usr/bin/env python3
"""
One-shot script: read bars from local relay and push to Railway ingest.
Run after Railway redeploys to immediately seed Railway with history.
Usage:  python runtime/push_history_now.py
"""
import json
import os
import sys
from pathlib import Path

import requests

# Load .env
for raw in Path(".env").read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    os.environ.setdefault(k.strip(), v.strip())

RELAY    = os.environ.get("PRICE_RELAY_URL", "http://127.0.0.1:8082")
INGEST   = os.environ.get("RAILWAY_INGEST_URL", "")
TOKEN    = os.environ.get("RELAY_INGEST_TOKEN", "") or os.environ.get("RAILWAY_RELAY_TOKEN", "")
SYMBOLS  = [
    "BTCUSDm","ETHUSDm","EURUSDm","GBPUSDm","USDJPYm",
    "XAUUSDm","USDCADm","AUDUSDm","NZDUSDm","USDCHFm","EURGBPm","USOILm"
]

if not INGEST:
    sys.exit("ERROR: RAILWAY_INGEST_URL not set in .env")

print(f"Relay:  {RELAY}")
print(f"Target: {INGEST}")

# Verify relay is up
try:
    h = requests.get(f"{RELAY}/health", timeout=4).json()
    print(f"Relay online — uptime={h.get('uptime_s',0):.0f}s  buf_syms={h.get('candle_buf_syms',0)}")
except Exception as e:
    sys.exit(f"ERROR: relay unreachable: {e}")

# Fetch bars for each symbol
symbols_data = []
for sym in SYMBOLS:
    try:
        d = requests.get(f"{RELAY}/candles?symbol={sym}&tf=1m&count=1500", timeout=8).json()
        bars = d.get("bars", [])
        if bars:
            symbols_data.append({"symbol": sym, "bars": bars})
            print(f"  {sym}: {len(bars)} bars")
        else:
            print(f"  {sym}: 0 bars (skipped)")
    except Exception as e:
        print(f"  {sym}: ERROR {e}")

if not symbols_data:
    sys.exit("ERROR: no bars fetched from relay")

total_bars = sum(len(e["bars"]) for e in symbols_data)
payload = {
    "type":          "historical_bulk",
    "connection_id": "push_script",
    "symbols":       [e["symbol"] for e in symbols_data],
    "total_bars":    total_bars,
    "symbols_data":  symbols_data,
}

headers = {"Content-Type": "application/json"}
if TOKEN:
    headers["Authorization"] = f"Bearer {TOKEN}"

print(f"\nPushing {len(symbols_data)} symbols / {total_bars} bars to Railway...")
resp = requests.post(INGEST, json=payload, headers=headers, timeout=60)
print(f"Result: HTTP {resp.status_code} — {resp.text[:200]}")
