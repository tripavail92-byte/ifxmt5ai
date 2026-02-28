"use client";

/**
 * usePriceFeed — SSE hook for live MT5 price and candle data  (Sprint 5)
 *
 * Connects to GET /api/stream (Server-Sent Events).
 * Reconnects automatically with exponential back-off on disconnect.
 *
 * Usage:
 *   const { prices, forming, lastClose, symbols, isConnected } = usePriceFeed();
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types (mirror CandleBar / PriceSnapshot from mt5-state.ts) ───────────────

export interface PriceSnapshot {
  bid:   number;
  ask:   number;
  ts_ms: number;
}

export interface CandleBar {
  t: number;  // unix epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ClosedBar {
  symbol: string;
  bar:    CandleBar;
}

export interface PriceFeedState {
  prices:      Record<string, PriceSnapshot>;  // symbol -> latest bid/ask
  forming:     Record<string, CandleBar>;       // symbol -> current 1m forming bar
  lastClose:   ClosedBar | null;                // most recently closed bar
  symbols:     string[];                        // symbols known to the relay
  isConnected: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePriceFeed(connId?: string): PriceFeedState {
  const [state, setState] = useState<PriceFeedState>({
    prices:      {},
    forming:     {},
    lastClose:   null,
    symbols:     [],
    isConnected: false,
  });

  const esRef      = useRef<EventSource | null>(null);
  const backoffRef = useRef<number>(1_000);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const qs  = connId ? `?conn_id=${encodeURIComponent(connId)}` : "";
    const url = `/api/stream${qs}`;
    const es  = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      backoffRef.current = 1_000;
      setState(s => ({ ...s, isConnected: true }));
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (!mountedRef.current) return;
      setState(s => ({ ...s, isConnected: false }));
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 30_000);
      timerRef.current = setTimeout(connect, delay);
    };

    // ── SSE event handlers ──────────────────────────────────────────────────

    es.addEventListener("init", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(e.data) as {
          prices?: Record<string, PriceSnapshot>;
          forming?: Record<string, CandleBar>;
          symbols?: string[];
        };
        setState(s => ({
          ...s,
          isConnected: true,
          prices:  d.prices  ?? s.prices,
          forming: d.forming ?? s.forming,
          symbols: d.symbols?.length ? d.symbols : s.symbols,
        }));
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("prices", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(e.data) as { prices: Record<string, PriceSnapshot> };
        setState(s => ({
          ...s,
          prices: { ...s.prices, ...d.prices },
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener("candle_update", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(e.data) as { forming: Record<string, CandleBar> };
        setState(s => ({
          ...s,
          forming: { ...s.forming, ...d.forming },
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener("candle_close", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(e.data) as { symbol: string; bar: CandleBar };
        if (d.symbol && d.bar) {
          setState(s => ({ ...s, lastClose: { symbol: d.symbol, bar: d.bar } }));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("connected", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(e.data) as { symbols?: string[] };
        if (d.symbols?.length) {
          setState(s => ({ ...s, symbols: d.symbols! }));
        }
      } catch { /* ignore */ }
    });

    // heartbeat — no-op; keeps connection warm
    es.addEventListener("heartbeat", () => { /* alive */ });

  }, [connId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      esRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [connect]);

  return state;
}
