/**
 * GET /api/candles
 *
 * Returns broker-native OHLCV bars from the direct MT5 -> Railway ingest -> Redis pipeline.
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
import { getRedisCandles, getRedisForming } from "@/lib/mt5-redis";
import { resolveTerminalAccess } from "@/lib/terminal-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
const MIN_STATE_BARS = 20;
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";
const CANDLE_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_CANDLE_STATE_MAX_AGE_MS ?? "15000").trim(), 10) || 15000
);

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

function sortAndDedupeBars(bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>) {
  const byTime = new Map<number, { t: number; o: number; h: number; l: number; c: number; v: number }>();
  for (const bar of bars) {
    if (!bar?.t) continue;
    byTime.set(bar.t, bar);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function hasTimeGap(
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
  tfMin: number
) {
  if (bars.length < 2) return false;

  const expectedDelta = tfMin * 60;
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].t - bars[index - 1].t > expectedDelta) {
      return true;
    }
  }

  return false;
}

function takeTrailingContiguousBars(
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
  tfMin: number,
  count: number
) {
  if (bars.length <= 1) return bars;

  const expectedDelta = tfMin * 60;
  let startIndex = Math.max(0, bars.length - count);

  for (let index = bars.length - 1; index > 0; index -= 1) {
    if (bars[index].t - bars[index - 1].t > expectedDelta) {
      startIndex = Math.max(startIndex, index);
      break;
    }
  }

  return bars.slice(startIndex);
}

function aggregateBars(
  bars1m: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
  tfMin: number
) {
  if (tfMin === 1) return [...bars1m];
  const slotSec = tfMin * 60;
  const out: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];

  for (const bar of bars1m) {
    const slot = Math.floor(bar.t / slotSec) * slotSec;
    const last = out[out.length - 1];
    if (last && last.t === slot) {
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
      last.v += bar.v;
    } else {
      out.push({ t: slot, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    }
  }
  return out;
}

function appendFormingBar(
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
  forming: { t: number; o: number; h: number; l: number; c: number; v: number } | undefined,
  tfMin: number
) {
  if (!forming?.t) return bars;
  const slotSec = tfMin * 60;
  const snapped = { ...forming, t: Math.floor(forming.t / slotSec) * slotSec };
  const next = [...bars];
  const last = next[next.length - 1];
  if (!last || last.t < snapped.t) {
    next.push(snapped);
  } else if (last.t === snapped.t) {
    next[next.length - 1] = snapped;
  }
  return next;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const symbol = searchParams.get("symbol") ?? "";
  const tf     = searchParams.get("tf")     ?? "1m";
  const count  = Math.min(parseInt(searchParams.get("count") ?? "300", 10), 1500);
  const requestedConnId = searchParams.get("conn_id") ?? "";

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }
  if (!TF_MINUTES[tf]) {
    return NextResponse.json(
      { error: `tf must be one of: ${Object.keys(TF_MINUTES).join(", ")}` },
      { status: 400 }
    );
  }

  const access = await resolveTerminalAccess(requestedConnId || undefined);
  if (!access.authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const stateConnId = access.connId;
  if (!stateConnId) {
    return NextResponse.json({ error: "conn_id required" }, { status: 400 });
  }

  // Fast-path: serve from connection-scoped in-memory state only.
  // Do not merge bars from other connections here; that can leak unrelated
  // symbol streams into the active chart and create visual gaps.
  const tfMin = TF_MINUTES[tf] ?? 1;
  const redisBars1m = await getRedisCandles(stateConnId, symbol, Math.max(count, MIN_STATE_BARS) * tfMin);
  const redisForming = await getRedisForming(stateConnId);
  const aggregatedRedisBars = sortAndDedupeBars(appendFormingBar(aggregateBars(redisBars1m, tfMin), redisForming[symbol], tfMin));
  const rawStateBars = aggregatedRedisBars.length
    ? aggregatedRedisBars
    : mt5State.getCandles(stateConnId, symbol, tf, count);
  const exactStateBars = takeTrailingContiguousBars(rawStateBars, tfMin, count);
  const stateBars = exactStateBars.length > count ? exactStateBars.slice(-count) : exactStateBars;
  const stateIsFresh = connectionStateIsFresh(stateConnId);
  const stateHasGap = hasTimeGap(stateBars, tfMin);

  return NextResponse.json(
    {
      symbol,
      tf,
      count: stateBars.length,
      source: "state",
      bars: stateBars,
      debug: {
        exact_state_count: exactStateBars.length,
        redis_count: aggregatedRedisBars.length,
        state_has_gap: stateHasGap,
        state_is_fresh: stateIsFresh,
        direct_only: true,
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
