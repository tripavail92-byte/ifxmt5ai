/**
 * GET /api/candles
 *
 * Returns broker-native OHLCV bars from the MT5 terminal via price_relay /candles.
 * Single source of truth: do not synthesize candles in the frontend.
 *
 * Query params:
 *   symbol  — required, e.g. BTCUSDm
 *   tf      — timeframe: 1m | 3m | 5m | 15m | 30m | 1h | 4h | 1d  (default: 1m)
 *   count   — number of bars to return (default: 300, max: 1500)
 *   conn_id — required connection UUID (selects the correct broker terminal)
 */

import { NextRequest, NextResponse } from "next/server";
import { mt5State, TF_MINUTES } from "@/lib/mt5-state";

export const runtime = "nodejs";
const MIN_STATE_BARS = 20;

const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);

type RelayFetchResult = {
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> | null;
  error?: string;
};

async function fetchRelayCandles(opts: {
  symbol: string;
  tf: string;
  count: number;
  connId?: string;
}): Promise<RelayFetchResult> {
  if (!PRICE_RELAY_URL) return { bars: null, error: "PRICE_RELAY_URL not configured" };

  const url = new URL("/candles", PRICE_RELAY_URL);
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("tf", opts.tf);
  url.searchParams.set("count", String(opts.count));
  if (opts.connId) url.searchParams.set("conn_id", opts.connId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!resp.ok) {
      return { bars: null, error: `relay returned ${resp.status}` };
    }
    const data = (await resp.json()) as { bars?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
    if (!data?.bars?.length) return { bars: [] };
    return { bars: data.bars };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = msg.toLowerCase().includes("abort");
    if (isAbort) {
      return { bars: null, error: `relay timeout after ${PRICE_RELAY_TIMEOUT_MS}ms` };
    }
    return { bars: null, error: `relay fetch failed: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const symbol = searchParams.get("symbol") ?? "";
  const tf     = searchParams.get("tf")     ?? "1m";
  const count  = Math.min(parseInt(searchParams.get("count") ?? "300", 10), 1500);
  const connId = searchParams.get("conn_id") ?? "";

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }
  if (!connId) {
    return NextResponse.json({ error: "conn_id required" }, { status: 400 });
  }
  if (!TF_MINUTES[tf]) {
    return NextResponse.json(
      { error: `tf must be one of: ${Object.keys(TF_MINUTES).join(", ")}` },
      { status: 400 }
    );
  }

  // Fast-path: serve from in-memory state (populated via /api/mt5/ingest).
  // Try exact conn_id first, then merged-all-connections to handle conn_id
  // drift between browser selection and relay push source.
  let stateBars = mt5State.getCandles(connId, symbol, tf, count);
  if (!stateBars.length) {
    // Empty string → getCandles merges across all known connections
    stateBars = mt5State.getCandles("", symbol, tf, count);
  }

  // If state has enough bars, trust it and skip relay fetch.
  if (stateBars.length >= MIN_STATE_BARS) {
    return NextResponse.json(
      { symbol, tf, count: stateBars.length, source: "state", bars: stateBars },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!PRICE_RELAY_URL) {
    // No relay configured; return whatever state has (possibly empty).
    return NextResponse.json(
      { symbol, tf, count: stateBars.length, source: "state", bars: stateBars },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const relay = await fetchRelayCandles({ symbol, tf, count, connId });
  if (relay.bars === null) {
    // Relay unavailable; return current state bars (possibly empty) so UI keeps
    // running and can fill via SSE/state later.
    return NextResponse.json(
      { symbol, tf, count: stateBars.length, source: "state", bars: stateBars },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const bestBars = relay.bars.length > stateBars.length ? relay.bars : stateBars;
  const source = relay.bars.length > stateBars.length ? "relay" : "state";

  // Seed state from relay history so subsequent calls can hit the fast-path.
  try {
    if (relay.bars.length) {
      mt5State.applyHistoricalBulk(connId, [{ symbol, bars: relay.bars }]);
    }
  } catch {
    // Best-effort seeding only.
  }

  return NextResponse.json(
    { symbol, tf, count: bestBars.length, source, bars: bestBars },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
