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
import { getRedisForming, getRedisPrices, getRedisSymbols } from "@/lib/mt5-redis";
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
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";
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

function reconcilePricesFromForming(
  prices: Record<string, { bid: number; ask: number; ts_ms: number }>,
  forming: Record<string, { t: number; o: number; h: number; l: number; c: number; v: number }>
) {
  const merged = { ...prices };
  let updatedCount = 0;

  for (const [symbol, bar] of Object.entries(forming)) {
    const formingTsMs = Number(bar?.t ?? 0) * 1000;
    const close = Number(bar?.c ?? 0);
    if (!formingTsMs || !Number.isFinite(close) || close <= 0) continue;

    const prev = merged[symbol];
    const prevTsMs = Number(prev?.ts_ms ?? 0);
    if (prevTsMs >= formingTsMs) continue;

    const spread = prev && Number.isFinite(prev.ask - prev.bid) && (prev.ask - prev.bid) >= 0
      ? prev.ask - prev.bid
      : 0;

    merged[symbol] = {
      bid: close,
      ask: close + spread,
      ts_ms: formingTsMs,
    };
    updatedCount += 1;
  }

  return { prices: merged, updatedCount };
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
  const debug = searchParams.get("debug") === "1";
  const access = await resolveTerminalAccess(requestedConnId ?? undefined);

  if (!access.authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const stateConnId = access.connId || undefined;
  const relayConnId = relayConnectionId(stateConnId);

  const redisPrices = stateConnId ? await getRedisPrices(stateConnId) : {};
  const redisForming = stateConnId ? await getRedisForming(stateConnId) : {};
  const memoryPrices = mt5State.getPrices(stateConnId);
  const memoryForming = mt5State.getForming(stateConnId);
  const mergedBasePrices = Object.keys(redisPrices).length ? redisPrices : memoryPrices;
  const mergedBaseForming = Object.keys(redisForming).length ? redisForming : memoryForming;

  const reconciledState = reconcilePricesFromForming(mergedBasePrices, mergedBaseForming);
  const stateAll = reconciledState.prices;
  const statePrices = symbol ? (stateAll[symbol] ? { [symbol]: stateAll[symbol] } : {}) : stateAll;
  let all = stateAll;
  let prices = statePrices;
  const stateIsFresh = hasFreshPrices(stateAll);
  const stateNewestBeforeFallback = newestPriceTs(stateAll);
  let relayNewest = 0;
  let selectedSource: "state" | "relay" = "state";

  // If this instance has cold or stale in-memory state, prefer relay data when available.
  if (!Object.keys(prices).length || !stateIsFresh) {
    const relayPrices = await fetchRelayPrices(relayConnId);
    if (relayPrices && Object.keys(relayPrices).length) {
      relayNewest = newestPriceTs(relayPrices);
      const stateNewest = newestPriceTs(stateAll);
      if (!stateNewest || relayNewest >= stateNewest || !stateIsFresh) {
        all = relayPrices;
        prices = symbol ? (all[symbol] ? { [symbol]: all[symbol] } : {}) : all;
        selectedSource = "relay";
      }
    }
  }

  const redisSymbols = stateConnId ? await getRedisSymbols(stateConnId) : [];
  const stateSymbols = stateConnId ? mt5State.getSymbols(stateConnId) : mt5State.getSymbols();
  const symbols = [...new Set([...redisSymbols, ...stateSymbols, ...Object.keys(all)])];

  return NextResponse.json(
    debug
      ? {
          prices,
          symbols,
          debug: {
            instance: INSTANCE_ID,
            source: selectedSource,
            redis_prices: Object.keys(redisPrices).length,
            redis_forming: Object.keys(redisForming).length,
            state_conn_id: stateConnId,
            relay_conn_id: relayConnId,
            state_is_fresh: stateIsFresh,
            forming_price_repairs: reconciledState.updatedCount,
            state_newest_ts_ms: stateNewestBeforeFallback,
            relay_newest_ts_ms: relayNewest,
            selected_newest_ts_ms: newestPriceTs(prices),
          },
        }
      : { prices, symbols },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
