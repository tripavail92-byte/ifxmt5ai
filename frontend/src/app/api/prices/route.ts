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

const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);
const PRICE_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_PRICE_STATE_MAX_AGE_MS ?? "3000").trim(), 10) || 3000
);

function newestPriceTs(prices: Record<string, { bid: number; ask: number; ts_ms: number }>): number {
  let newest = 0;
  for (const snap of Object.values(prices)) {
    if (snap?.ts_ms && snap.ts_ms > newest) newest = snap.ts_ms;
  }
  return newest;
}

function hasFreshPrices(prices: Record<string, { bid: number; ask: number; ts_ms: number }>): boolean {
  const newest = newestPriceTs(prices);
  return newest > 0 && (Date.now() - newest) <= PRICE_STATE_MAX_AGE_MS;
}

async function fetchRelayPrices(connId?: string): Promise<Record<string, { bid: number; ask: number; ts_ms: number }> | null> {
  if (!PRICE_RELAY_URL) return null;

  const url = new URL("/prices", PRICE_RELAY_URL);
  if (connId) url.searchParams.set("conn_id", connId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      prices?: Record<string, { bid: number; ask: number; ts_ms: number }>;
    };
    return data?.prices ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const connId = searchParams.get("conn_id") ?? undefined;
  const symbol = searchParams.get("symbol")  ?? undefined;

  const stateAll = mt5State.getPrices(connId);
  const statePrices = symbol ? (stateAll[symbol] ? { [symbol]: stateAll[symbol] } : {}) : stateAll;
  let all = stateAll;
  let prices = statePrices;
  const stateIsFresh = hasFreshPrices(stateAll);

  // If this instance has cold or stale in-memory state, prefer relay data when available.
  if (!Object.keys(prices).length || !stateIsFresh) {
    const relayPrices = await fetchRelayPrices(connId);
    if (relayPrices && Object.keys(relayPrices).length) {
      const relayNewest = newestPriceTs(relayPrices);
      const stateNewest = newestPriceTs(stateAll);
      if (!stateNewest || relayNewest >= stateNewest || !stateIsFresh) {
        all = relayPrices;
        prices = symbol ? (all[symbol] ? { [symbol]: all[symbol] } : {}) : all;
      }
    }
  }

  const stateSymbols = connId ? mt5State.getSymbols(connId) : mt5State.getSymbols();
  const symbols = [...new Set([...stateSymbols, ...Object.keys(all)])];

  return NextResponse.json(
    { prices, symbols },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
