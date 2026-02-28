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

  const bars = mt5State.getCandles(connId, symbol, tf, count);

  return NextResponse.json(
    { symbol, tf, count: bars.length, bars },
    {
      headers: {
        // Short cache — chart can poll every few seconds for latest
        "Cache-Control": "public, max-age=2, stale-while-revalidate=5",
      },
    }
  );
}
