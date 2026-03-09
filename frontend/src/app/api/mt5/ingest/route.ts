/**
 * POST /api/mt5/ingest
 *
 * Receives data from the VPS price_relay.py (HTTP POST, not WebSocket).
 * Authenticated by the RELAY_INGEST_TOKEN env var (optional — if blank, accepts all).
 *
 * Body shapes (same types price_relay.py enqueues):
 *   { type: "tick_batch",       connection_id, ts_ms, ticks, forming_candles }
 *   { type: "candle_close",     connection_id, symbol, timeframe, bar }
 *   { type: "historical_bulk",  connection_id, symbols, total_bars }
 *   { type: "connected",        connection_id, symbols }
 */

import { NextRequest, NextResponse } from "next/server";
import { mt5State } from "@/lib/mt5-state";

const INGEST_TOKEN = process.env.RELAY_INGEST_TOKEN ?? "";
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";

export const runtime = "nodejs";  // required for in-memory state access

export async function POST(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  if (INGEST_TOKEN) {
    const auth = req.headers.get("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (provided !== INGEST_TOKEN) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const type   = body.type   as string;
  const connId = (body.connection_id as string) ?? "default";

  // ── Dispatch ──────────────────────────────────────────────────────────────
  switch (type) {

    case "tick_batch": {
      const ticks   = (body.ticks           as Array<{ symbol: string; bid: number; ask: number; ts_ms: number }>) ?? [];
      const forming = (body.forming_candles as Array<{ symbol: string; time: number; open: number; high: number; low: number; close: number; tick_vol: number }>) ?? [];
      mt5State.applyTickBatch(connId, ticks, forming);
      break;
    }

    case "candle_close": {
      const bar = body.bar as { t: number; o: number; h: number; l: number; c: number; v: number };
      const symbol = body.symbol as string;
      if (bar && symbol) {
        mt5State.applyCandleClose(connId, symbol, bar);
      }
      break;
    }

    case "historical_bulk": {
      // Abbreviated payload: relay sends symbol names + total_bars only.
      // Full bar data comes via the VPS /candles REST endpoint.
      // If relay sends full bars (optional), seed from them.
      const symbolsData = body.symbols_data as Array<{ symbol: string; bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> }> | undefined;
      const symbolNames = body.symbols as string[] | undefined;

      if (symbolsData?.length) {
        mt5State.applyHistoricalBulk(connId, symbolsData);
      } else if (symbolNames?.length) {
        // No bar data in payload — just register symbol list
        mt5State.symbols.set(connId, symbolNames);
        mt5State.broadcast({ type: "connected", connection_id: connId, symbols: symbolNames });
      }
      break;
    }

    case "connected": {
      const symbols = body.symbols as string[] | undefined;
      if (symbols?.length) {
        mt5State.symbols.set(connId, symbols);
        mt5State.broadcast({ type: "connected", connection_id: connId, symbols });
      }
      break;
    }

    default:
      return NextResponse.json({ error: `unknown type: ${type}` }, { status: 400 });
  }

  return NextResponse.json({
    ok:          true,
    type,
    subscribers: mt5State.subscriberCount,
  });
}

// Allow relay health-check
export async function GET() {
  return NextResponse.json({
    status:      "ok",
    subscribers: mt5State.subscriberCount,
    symbols:     mt5State.getSymbols(),
    instance:    INSTANCE_ID,
  });
}
