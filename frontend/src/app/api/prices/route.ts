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
import { PUBLIC_PRICE_RELAY_URL, SERVER_PRICE_RELAY_URL, relayConnectionId } from "@/lib/price-relay";
import { resolveTerminalAccess } from "@/lib/terminal-access";

export const runtime = "nodejs";

const PRICE_RELAY_URL = SERVER_PRICE_RELAY_URL;
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "30000").trim(), 10) || 30000
);
const PRICE_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_PRICE_STATE_MAX_AGE_MS ?? "3000").trim(), 10) || 3000
);
let lastRelaySnapshot: Record<string, { bid: number; ask: number; ts_ms: number }> | null = null;

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

async function fetchRelayPricesFrom(baseUrl: string, connId?: string): Promise<Record<string, { bid: number; ask: number; ts_ms: number }> | null> {
  if (!baseUrl) return null;

  const url = new URL("/prices", baseUrl);
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

async function fetchRelayPrices(connId?: string): Promise<Record<string, { bid: number; ask: number; ts_ms: number }> | null> {
  const candidates = [...new Set([PRICE_RELAY_URL, PUBLIC_PRICE_RELAY_URL].filter(Boolean))];
  for (const baseUrl of candidates) {
    const first = await fetchRelayPricesFrom(baseUrl, connId);
    if (first && Object.keys(first).length) {
      lastRelaySnapshot = first;
      return first;
    }

    const retry = await fetchRelayPricesFrom(baseUrl, connId);
    if (retry && Object.keys(retry).length) {
      lastRelaySnapshot = retry;
      return retry;
    }
  }

  if (!connId && lastRelaySnapshot && hasFreshPrices(lastRelaySnapshot)) {
    return lastRelaySnapshot;
  }

  return null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const requestedConnId = searchParams.get("conn_id") ?? undefined;
  const symbol = searchParams.get("symbol")  ?? undefined;
  const access = await resolveTerminalAccess(requestedConnId ?? undefined);

  if (!access.authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const connId = access.connId || undefined;
  const relayConnId = relayConnectionId(connId);

  const stateAll = mt5State.getPrices(relayConnId);
  const statePrices = symbol ? (stateAll[symbol] ? { [symbol]: stateAll[symbol] } : {}) : stateAll;
  let all = stateAll;
  let prices = statePrices;
  const stateIsFresh = hasFreshPrices(stateAll);

  // If this instance has cold or stale in-memory state, prefer relay data when available.
  if (!Object.keys(prices).length || !stateIsFresh) {
    const relayPrices = await fetchRelayPrices(relayConnId);
    if (relayPrices && Object.keys(relayPrices).length) {
      const relayNewest = newestPriceTs(relayPrices);
      const stateNewest = newestPriceTs(stateAll);
      if (!stateNewest || relayNewest >= stateNewest || !stateIsFresh) {
        all = relayPrices;
        prices = symbol ? (all[symbol] ? { [symbol]: all[symbol] } : {}) : all;
      }
    }
  }

  const stateSymbols = relayConnId ? mt5State.getSymbols(relayConnId) : mt5State.getSymbols();
  const symbols = [...new Set([...stateSymbols, ...Object.keys(all)])];

  return NextResponse.json(
    { prices, symbols },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
