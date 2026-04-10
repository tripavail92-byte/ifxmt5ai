/**
 * GET /api/stream
 *
 * Server-Sent Events stream for live MT5 price data.
 *
 * Two modes:
 *  1. Warm Redis state       → stream directly from Redis pubsub/state
 *  2. Warm Railway state     → stream directly from in-memory `mt5State`
 *
 * Events emitted:
 *   connected     — {type, connection_id, symbols[]}
 *   init          — initial snapshot {prices, symbols}
 *   prices        — {type, connection_id, prices: {symbol: {bid,ask,ts_ms}}}
 *   candle_close  — {type, connection_id, symbol, bar: CandleBar}
 *   heartbeat     — {type, ts} every 15s
 *
 * Query params:
 *   ?conn_id=<uuid>   filter events to a specific connection (optional)
 */

import { NextRequest } from "next/server";
import { mt5State, type SseSubscriber } from "@/lib/mt5-state";
import {
  createRedisSubscriber,
  getRedisForming,
  getRedisPrices,
  getRedisSymbols,
} from "@/lib/mt5-redis";
import { resolveTerminalAccess } from "@/lib/terminal-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const WARM_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_STREAM_WARM_MAX_AGE_MS ?? "3000").trim(), 10) || 3000
);

function sseMessage(payload: object): Uint8Array {
  const type = (payload as { type?: string }).type ?? "message";
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function hasWarmState(connFilter?: string): boolean {
  const now = Date.now();
  const prices = mt5State.getPrices(connFilter);
  for (const snap of Object.values(prices)) {
    if (snap?.ts_ms && now - snap.ts_ms <= WARM_STATE_MAX_AGE_MS) {
      return true;
    }
  }

  if (connFilter) {
    const forming = mt5State.forming.get(connFilter);
    if (!forming || forming.size === 0) return false;
    for (const bar of forming.values()) {
      if (bar?.t && now - bar.t * 1000 <= WARM_STATE_MAX_AGE_MS) {
        return true;
      }
    }
    return false;
  }

  for (const [, forming] of mt5State.forming) {
    for (const bar of forming.values()) {
      if (bar?.t && now - bar.t * 1000 <= WARM_STATE_MAX_AGE_MS) {
        return true;
      }
    }
  }

  return false;
}

async function hasWarmRedisState(connFilter?: string): Promise<boolean> {
  if (!connFilter) return false;

  const now = Date.now();
  const prices = await getRedisPrices(connFilter);
  for (const snap of Object.values(prices)) {
    if (snap?.ts_ms && now - snap.ts_ms <= WARM_STATE_MAX_AGE_MS) {
      return true;
    }
  }

  const forming = await getRedisForming(connFilter);
  for (const bar of Object.values(forming)) {
    if (bar?.t && now - bar.t * 1000 <= WARM_STATE_MAX_AGE_MS) {
      return true;
    }
  }

  return false;
}

function pricePayloadFromTickBatch(payload: {
  connection_id?: string;
  ticks?: Array<{ symbol: string; bid: number; ask: number; ts_ms: number }>;
}) {
  const prices: Record<string, { bid: number; ask: number; ts_ms: number }> = {};
  for (const tick of payload.ticks ?? []) {
    prices[tick.symbol] = { bid: tick.bid, ask: tick.ask, ts_ms: tick.ts_ms };
  }
  return {
    type: "prices",
    connection_id: payload.connection_id,
    prices,
  };
}

function candleUpdatePayloadFromTickBatch(payload: {
  connection_id?: string;
  forming_candles?: Array<{ symbol: string; time: number; open: number; high: number; low: number; close: number; tick_vol: number }>;
}) {
  const forming: Record<string, { t: number; o: number; h: number; l: number; c: number; v: number }> = {};
  for (const candle of payload.forming_candles ?? []) {
    forming[candle.symbol] = {
      t: candle.time,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.tick_vol,
    };
  }
  return {
    type: "candle_update",
    connection_id: payload.connection_id,
    forming,
  };
}

async function streamFromRedis(req: NextRequest, connFilter?: string): Promise<Response | null> {
  const subscriber = await createRedisSubscriber();
  if (!subscriber) return null;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      await subscriber.quit();
    } catch {
      try {
        subscriber.disconnect();
      } catch {
        // ignore
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const symbols = connFilter ? await getRedisSymbols(connFilter) : mt5State.getSymbols();
      const prices = connFilter ? await getRedisPrices(connFilter) : mt5State.getPrices();
      const forming = connFilter ? await getRedisForming(connFilter) : mt5State.getForming();
      controller.enqueue(sseMessage({ type: "init", symbols, prices, forming }));

      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(sseMessage({ type: "heartbeat", ts: Date.now() }));
        } catch {
          void close();
        }
      }, 2_500);

      const handleMessage = (raw: string) => {
        try {
          const payload = JSON.parse(raw) as {
            type?: string;
            connection_id?: string;
            ticks?: Array<{ symbol: string; bid: number; ask: number; ts_ms: number }>;
            forming_candles?: Array<{ symbol: string; time: number; open: number; high: number; low: number; close: number; tick_vol: number }>;
          };

          if (payload.type === "tick_batch") {
            const pricesEvent = pricePayloadFromTickBatch(payload);
            if (Object.keys(pricesEvent.prices).length) {
              controller.enqueue(sseMessage(pricesEvent));
            }

            const candleEvent = candleUpdatePayloadFromTickBatch(payload);
            if (Object.keys(candleEvent.forming).length) {
              controller.enqueue(sseMessage(candleEvent));
            }
            return;
          }

          controller.enqueue(sseMessage(payload));
        } catch {
          // ignore malformed pubsub payloads
        }
      };

      if (connFilter) {
        await subscriber.subscribe(`mt5:${connFilter}:prices`, handleMessage);
        await subscriber.subscribe(`mt5:${connFilter}:candles`, handleMessage);
        await subscriber.subscribe(`mt5:${connFilter}:connected`, handleMessage);
      } else {
        await subscriber.pSubscribe("mt5:*:prices", handleMessage);
        await subscriber.pSubscribe("mt5:*:candles", handleMessage);
        await subscriber.pSubscribe("mt5:*:connected", handleMessage);
      }

      req.signal.addEventListener("abort", () => {
        void close();
      });
    },
    cancel() {
      void close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Fallback: stream from Railway in-memory mt5State */
function streamFromState(req: NextRequest, connFilter?: string): Response {
  let sub: SseSubscriber | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sub = { controller, connFilter };
      mt5State.addSubscriber(sub);

      const symbols = mt5State.getSymbols(connFilter);
      const prices  = mt5State.getPrices(connFilter);
      const forming = mt5State.getForming(connFilter);
      controller.enqueue(sseMessage({ type: "init", symbols, prices, forming, subscribers: mt5State.subscriberCount }));

      // Send frequent heartbeats to prevent frontend from detecting the stream as dead.
      // Frontend considers stream stale after 4s without events, so heartbeat every 2.5s.
      heartbeatTimer = setInterval(() => {
        try { controller.enqueue(sseMessage({ type: "heartbeat", ts: Date.now() })); }
        catch { /* closed */ }
      }, 2_500);
    },
    cancel() {
      if (sub) mt5State.removeSubscriber(sub);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (sub) mt5State.removeSubscriber(sub);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type":      "text/event-stream; charset=utf-8",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(req: NextRequest) {
  const requestedConnId = req.nextUrl.searchParams.get("conn_id") ?? undefined;
  const access = await resolveTerminalAccess(requestedConnId ?? undefined);

  if (!access.authorized) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stateConnFilter = access.connId || undefined;

  if (await hasWarmRedisState(stateConnFilter)) {
    const redisStream = await streamFromRedis(req, stateConnFilter);
    if (redisStream) return redisStream;
  }

  if (hasWarmState(stateConnFilter)) {
    return streamFromState(req, stateConnFilter);
  }

  const redisStream = await streamFromRedis(req, stateConnFilter);
  if (redisStream) return redisStream;

  return streamFromState(req, stateConnFilter);
}

