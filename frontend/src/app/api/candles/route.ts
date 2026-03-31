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
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";

const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);
const CANDLE_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_CANDLE_STATE_MAX_AGE_MS ?? "15000").trim(), 10) || 15000
);

type RelayFetchResult = {
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> | null;
  error?: string;
};

type RelayHealth = {
  relay_source_connection_id?: string;
  active_conn_ids?: string[];
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

async function fetchRelayHealth(): Promise<RelayHealth | null> {
  if (!PRICE_RELAY_URL) return null;

  const url = new URL("/health", PRICE_RELAY_URL);
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
    return (await resp.json()) as RelayHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function connectionStateIsFresh(connId: string): boolean {
  const now = Date.now();
  const prices = mt5State.getPrices(connId);
  for (const snap of Object.values(prices)) {
    if (snap?.ts_ms && now - snap.ts_ms <= CANDLE_STATE_MAX_AGE_MS) {
      return true;
    }
  }

  const forming = mt5State.forming.get(connId);
  if (!forming) return false;
  for (const bar of forming.values()) {
    if (bar?.t && now - bar.t * 1000 <= CANDLE_STATE_MAX_AGE_MS) {
      return true;
    }
  }
  return false;
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

  // Fast-path: serve from connection-scoped in-memory state only.
  // Do not merge bars from other connections here; that can leak unrelated
  // symbol streams into the active chart and create visual gaps.
  const exactStateBars = mt5State.getCandles(connId, symbol, tf, count);
  const stateBars = exactStateBars;
  const stateIsFresh = connectionStateIsFresh(connId);

  // If state has enough bars, trust it and skip relay fetch.
  if (stateBars.length >= MIN_STATE_BARS && stateIsFresh) {
    return NextResponse.json(
      {
        symbol,
        tf,
        count: stateBars.length,
        source: "state",
        bars: stateBars,
        debug: {
          exact_state_count: exactStateBars.length,
          instance: INSTANCE_ID,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!PRICE_RELAY_URL) {
    // No relay configured; return whatever state has (possibly empty).
    return NextResponse.json(
      {
        symbol,
        tf,
        count: stateBars.length,
        source: "state",
        bars: stateBars,
        debug: {
          exact_state_count: exactStateBars.length,
          relay_error: "PRICE_RELAY_URL not configured",
          instance: INSTANCE_ID,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  let relay = await fetchRelayCandles({ symbol, tf, count, connId });

  // If the selected terminal connection is not the VPS relay source connection,
  // retry once using the relay's active/source connection so history is still
  // available in the terminal chart.
  if (connId && (relay.bars === null || relay.bars.length < MIN_STATE_BARS)) {
    const health = await fetchRelayHealth();
    const fallbackConnId = health?.relay_source_connection_id || health?.active_conn_ids?.[0];
    if (fallbackConnId && fallbackConnId !== connId) {
      const fallbackRelay = await fetchRelayCandles({ symbol, tf, count, connId: fallbackConnId });
      if (fallbackRelay.bars && fallbackRelay.bars.length > (relay.bars?.length ?? 0)) {
        relay = fallbackRelay;
      }
    }
  }

  if (relay.bars === null) {
    // Relay unavailable; return current state bars (possibly empty) so UI keeps
    // running and can fill via SSE/state later.
    return NextResponse.json(
      {
        symbol,
        tf,
        count: stateBars.length,
        source: "state",
        bars: stateBars,
        debug: {
          exact_state_count: exactStateBars.length,
          relay_error: relay.error ?? null,
          instance: INSTANCE_ID,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const bestBars = !stateIsFresh || relay.bars.length >= stateBars.length ? relay.bars : stateBars;
  const source = bestBars === relay.bars ? "relay" : "state";

  // Seed state from relay history so subsequent calls can hit the fast-path.
  try {
    if (relay.bars.length) {
      mt5State.applyHistoricalBulk(connId, [{ symbol, bars: relay.bars }]);
    }
  } catch {
    // Best-effort seeding only.
  }

  return NextResponse.json(
    {
      symbol,
      tf,
      count: bestBars.length,
      source,
      bars: bestBars,
      debug: {
        exact_state_count: exactStateBars.length,
        relay_count: relay.bars.length,
        instance: INSTANCE_ID,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
