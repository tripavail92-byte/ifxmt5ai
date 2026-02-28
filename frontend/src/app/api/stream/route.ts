/**
 * GET /api/stream
 *
 * Server-Sent Events stream for live MT5 price data.
 * Browsers EventSource-connect here and receive:
 *
 *   connected     — {type, connection_id, symbols[]}
 *   candle_update — {type, connection_id, forming: {symbol: CandleBar}}
 *   candle_close  — {type, connection_id, symbol, bar: CandleBar}
 *   prices        — {type, connection_id, prices: {symbol: {bid,ask,ts_ms}}}
 *   heartbeat     — {type, ts} (every 15s to keep connection alive)
 *
 * Query params:
 *   ?conn_id=<uuid>   filter events to a specific connection (optional)
 */

import { NextRequest } from "next/server";
import { mt5State, type SseSubscriber } from "@/lib/mt5-state";

export const runtime = "nodejs";
// Disable body size limit — SSE is a long-lived streaming response
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function sseMessage(payload: object): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(req: NextRequest) {
  const connFilter = req.nextUrl.searchParams.get("conn_id") ?? undefined;

  let sub: SseSubscriber | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sub = { controller, connFilter };
      mt5State.addSubscriber(sub);

      // Send initial state snapshot immediately
      const symbols = mt5State.getSymbols(connFilter);
      const prices  = mt5State.getPrices(connFilter);

      controller.enqueue(sseMessage({
        type:          "init",
        symbols,
        prices,
        subscribers:   mt5State.subscriberCount,
      }));

      // Heartbeat every 15s (prevents Railway/proxy from closing idle connections)
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(sseMessage({ type: "heartbeat", ts: Date.now() }));
        } catch {
          // controller closed — will be cleaned up on abort
        }
      }, 15_000);
    },

    cancel() {
      if (sub) mt5State.removeSubscriber(sub);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  // Cleanup on client disconnect
  req.signal.addEventListener("abort", () => {
    if (sub) mt5State.removeSubscriber(sub);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type":  "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",  // disable nginx proxy buffering
    },
  });
}
