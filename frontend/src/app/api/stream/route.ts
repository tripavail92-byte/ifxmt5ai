/**
 * GET /api/stream
 *
 * Server-Sent Events stream for live MT5 price data.
 *
 * Two modes:
 *  1. Warm Railway state     → stream directly from in-memory `mt5State`
 *  2. Cold Railway state     → proxy relay SSE, then fall back to `mt5State` on timeout/error
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const RELAY_STREAM_URL = (process.env.RELAY_STREAM_URL ?? "").trim();
const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();
const RELAY_STREAM_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt((process.env.RELAY_STREAM_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);
const WARM_STATE_MAX_AGE_MS = Math.max(
  1000,
  Number.parseInt((process.env.MT5_STREAM_WARM_MAX_AGE_MS ?? "15000").trim(), 10) || 15000
);

type RelayHealth = {
  relay_source_connection_id?: string;
  active_conn_ids?: string[];
};

function sseMessage(payload: object): Uint8Array {
  const type = (payload as { type?: string }).type ?? "message";
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function fetchRelayHealth(): Promise<RelayHealth | null> {
  if (!PRICE_RELAY_URL) return null;

  const url = new URL("/health", PRICE_RELAY_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_STREAM_TIMEOUT_MS);
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

async function canUseRelayForConnection(connFilter?: string): Promise<boolean> {
  if (!connFilter) return true;
  if (!PRICE_RELAY_URL && !RELAY_STREAM_URL) return false;

  const health = await fetchRelayHealth();
  if (!health) return true;

  const relayConnId = health.relay_source_connection_id || health.active_conn_ids?.[0];
  if (!relayConnId) return true;
  return relayConnId === connFilter;
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
      controller.enqueue(sseMessage({ type: "init", symbols, prices, subscribers: mt5State.subscriberCount }));

      heartbeatTimer = setInterval(() => {
        try { controller.enqueue(sseMessage({ type: "heartbeat", ts: Date.now() })); }
        catch { /* closed */ }
      }, 15_000);
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

/** Primary: proxy relay SSE via Cloudflare Tunnel */
async function proxyRelayStream(req: NextRequest, connFilter?: string): Promise<Response> {
  const relayBaseUrl = RELAY_STREAM_URL
    ? new URL(RELAY_STREAM_URL)
    : PRICE_RELAY_URL
      ? new URL("/stream", PRICE_RELAY_URL)
      : null;

  if (!relayBaseUrl) {
    return streamFromState(req, connFilter);
  }

  const upstreamUrl = new URL(relayBaseUrl.toString());
  if (connFilter) upstreamUrl.searchParams.set("conn_id", connFilter);

  const abortCtrl = new AbortController();
  const timeout = setTimeout(() => abortCtrl.abort(), RELAY_STREAM_TIMEOUT_MS);
  req.signal.addEventListener("abort", () => abortCtrl.abort());

  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      signal:  abortCtrl.signal,
      cache:   "no-store",
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
    });

    if (!upstream.ok || !upstream.body) {
      return streamFromState(req, connFilter);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type":      "text/event-stream; charset=utf-8",
        "Cache-Control":     "no-cache, no-transform",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return streamFromState(req, connFilter);
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  const connFilter = req.nextUrl.searchParams.get("conn_id") ?? undefined;

  if ((RELAY_STREAM_URL || PRICE_RELAY_URL) && await canUseRelayForConnection(connFilter)) {
    const proxied = await proxyRelayStream(req, connFilter);
    if (proxied.ok) return proxied;
  }

  if (hasWarmState(connFilter)) {
    return streamFromState(req, connFilter);
  }

  return streamFromState(req, connFilter);
}

