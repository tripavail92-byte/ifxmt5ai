/**
 * GET /api/prices
 *
 * Returns the latest bid/ask snapshot for all (or filtered) symbols.
 *
 * Query params:
 *   conn_id — optional connection UUID filter
 *   symbol  — optional single symbol
 */

import { NextRequest, NextResponse } from "next/server";
import { mt5State } from "@/lib/mt5-state";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const connId = searchParams.get("conn_id") ?? undefined;
  const symbol = searchParams.get("symbol")  ?? undefined;

  const all = mt5State.getPrices(connId);

  const prices = symbol ? (all[symbol] ? { [symbol]: all[symbol] } : {}) : all;

  return NextResponse.json(
    { prices, symbols: mt5State.getSymbols(connId) },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
