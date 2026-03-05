/**
 * GET /api/candles
 *
 * Returns buffered OHLCV bars from the in-memory state.
 * Used by CandlestickChart on mount to load real history.
 *
 * Query params:
 *   symbol  — required, e.g. BTCUSDm
 *   tf      — timeframe: 1m | 5m | 15m | 1h | 4h | 1d  (default: 1m)
 *   count   — number of bars to return (default: 300, max: 1500)
 *   conn_id — optional connection UUID filter
 */

import { NextRequest, NextResponse } from "next/server";
import { mt5State, TF_MINUTES } from "@/lib/mt5-state";

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
  if (!TF_MINUTES[tf]) {
    return NextResponse.json(
      { error: `tf must be one of: ${Object.keys(TF_MINUTES).join(", ")}` },
      { status: 400 }
    );
  }

  // Local in-memory history (volatile across restarts/instance switches)
  const localAll = mt5State.getCandles(connId, symbol, tf, 1_000_000);
  const localBars = count < localAll.length ? localAll.slice(-count) : localAll;

  // Prefer whichever source has more history — relay is authoritative when healthy
  // (avoids "1 candle after refresh" when Next.js restarts), but fall back to
  // local when the relay only has its forming bar (0 closed bars yet).
  let bars = localBars;
  let source: "memory" | "relay" = "memory";

  const relayBars = await fetchRelayCandles({ symbol, tf, count, connId: connId || undefined });
  if (relayBars && relayBars.length > bars.length) {
    bars = relayBars;
    source = "relay";
  }

  return NextResponse.json(
    { symbol, tf, count: bars.length, total: localAll.length, source, bars },
    {
      headers: {
        // Short cache — chart can poll every few seconds for latest
        "Cache-Control": "public, max-age=2, stale-while-revalidate=5",
      },
    }
  );
}
