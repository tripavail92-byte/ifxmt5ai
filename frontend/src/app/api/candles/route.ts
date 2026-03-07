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
import { TF_MINUTES } from "@/lib/mt5-state";

export const runtime = "nodejs";

const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();

async function fetchRelayCandles(opts: {
  symbol: string;
  tf: string;
  count: number;
  connId?: string;
}): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> | null> {
  if (!PRICE_RELAY_URL) return null;

  const url = new URL("/candles", PRICE_RELAY_URL);
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("tf", opts.tf);
  url.searchParams.set("count", String(opts.count));
  if (opts.connId) url.searchParams.set("conn_id", opts.connId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { bars?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> };
    if (!data?.bars?.length) return [];
    return data.bars;
  } catch {
    return null;
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

  if (!PRICE_RELAY_URL) {
    return NextResponse.json({ error: "PRICE_RELAY_URL not configured" }, { status: 503 });
  }

  const relayBars = await fetchRelayCandles({ symbol, tf, count, connId });
  if (relayBars === null) {
    return NextResponse.json({ error: "relay unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    { symbol, tf, count: relayBars.length, source: "relay", bars: relayBars },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
