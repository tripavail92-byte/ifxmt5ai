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

const PUBLIC_PRICE_RELAY_URL = (process.env.NEXT_PUBLIC_PRICE_RELAY_URL ?? "").trim();
const MAX_SERVER_PRICE_AGE_MS = 10_000;

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
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventAtRef = useRef<number>(0);
  const mountedRef = useRef(true);

  const newestTs = useCallback((prices?: Record<string, PriceSnapshot>) => {
    let newest = 0;
    for (const snap of Object.values(prices ?? {})) {
      if (snap?.ts_ms && snap.ts_ms > newest) newest = snap.ts_ms;
    }
    return newest;
  }, []);

  const fetchDirectRelayPrices = useCallback(async () => {
    if (!PUBLIC_PRICE_RELAY_URL) return null;
    try {
      const url = new URL("/prices", PUBLIC_PRICE_RELAY_URL);
      if (connId) url.searchParams.set("conn_id", connId);
      const resp = await fetch(url.toString(), { cache: "no-store" });
      if (!resp.ok) return null;
      const data = await resp.json() as {
        prices?: Record<string, PriceSnapshot>;
        symbols?: string[];
      };
      return data;
    } catch {
      return null;
    }
  }, [connId]);

  const acceptsConn = useCallback((eventConnId?: string | null) => {
    if (!connId) return true;
    if (!eventConnId) return true;
    return eventConnId === connId;
  }, [connId]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const qs  = connId ? `?conn_id=${encodeURIComponent(connId)}` : "";
    const url = `/api/stream${qs}`;
    const es  = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      backoffRef.current = 1_000;
      lastEventAtRef.current = Date.now();
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
        lastEventAtRef.current = Date.now();
        const d = JSON.parse(e.data) as {
          connection_id?: string;
          prices?: Record<string, PriceSnapshot>;
          forming?: Record<string, CandleBar>;
          symbols?: string[];
        };
        if (!acceptsConn(d.connection_id)) return;
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
        lastEventAtRef.current = Date.now();
        const d = JSON.parse(e.data) as { connection_id?: string; prices: Record<string, PriceSnapshot> };
        if (!acceptsConn(d.connection_id)) return;
        setState(s => ({
          ...s,
          prices: { ...s.prices, ...d.prices },
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener("candle_update", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        lastEventAtRef.current = Date.now();
        const d = JSON.parse(e.data) as { connection_id?: string; forming: Record<string, CandleBar> };
        if (!acceptsConn(d.connection_id)) return;
        setState(s => ({
          ...s,
          forming: { ...s.forming, ...d.forming },
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener("candle_close", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        lastEventAtRef.current = Date.now();
        const d = JSON.parse(e.data) as { connection_id?: string; symbol: string; bar: CandleBar };
        if (!acceptsConn(d.connection_id)) return;
        if (d.symbol && d.bar) {
          setState(s => ({ ...s, lastClose: { symbol: d.symbol, bar: d.bar } }));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("connected", (e: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        lastEventAtRef.current = Date.now();
        const d = JSON.parse(e.data) as { connection_id?: string; symbols?: string[] };
        if (!acceptsConn(d.connection_id)) return;
        if (d.symbols?.length) {
          setState(s => ({ ...s, symbols: d.symbols! }));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("heartbeat", () => {
      lastEventAtRef.current = Date.now();
    });

  }, [acceptsConn, connId]);

  const pollPrices = useCallback(async () => {
    try {
      const qs = connId ? `?conn_id=${encodeURIComponent(connId)}` : "";
      const resp = await fetch(`/api/prices${qs}`, { cache: "no-store" });
      const data = resp.ok ? await resp.json() as {
        prices?: Record<string, PriceSnapshot>;
        symbols?: string[];
      } : null;

      let best = data;
      const serverNewest = newestTs(data?.prices);
      const serverIsStale = !serverNewest || (Date.now() - serverNewest) > MAX_SERVER_PRICE_AGE_MS;
      if (!best?.prices || !Object.keys(best.prices).length || serverIsStale) {
        const relayData = await fetchDirectRelayPrices();
        const relayNewest = newestTs(relayData?.prices);
        if (relayData?.prices && Object.keys(relayData.prices).length && relayNewest >= serverNewest) {
          best = relayData;
        }
      }

      if (!mountedRef.current) return;

      if (best?.prices && Object.keys(best.prices).length > 0) {
        setState(s => ({
          ...s,
          prices: { ...s.prices, ...best.prices },
          symbols: best.symbols?.length ? best.symbols : s.symbols,
          isConnected: true,
        }));
      }

      if (Date.now() - lastEventAtRef.current > 20_000) {
        esRef.current?.close();
        esRef.current = null;
        connect();
      }
    } catch {
    }
  }, [connId, connect]);

  useEffect(() => {
    setState({
      prices: {},
      forming: {},
      lastClose: null,
      symbols: [],
      isConnected: false,
    });
    lastEventAtRef.current = Date.now();
  }, [connId]);

  useEffect(() => {
    mountedRef.current = true;
    lastEventAtRef.current = Date.now();
    connect();
    pollRef.current = setInterval(() => {
      void pollPrices();
    }, 3000);
    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      esRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [connect, pollPrices]);

  return state;
}
