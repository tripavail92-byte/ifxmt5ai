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
const MAX_SERVER_PRICE_AGE_MS = 2_500;
const STREAM_STALE_MS = 4_000;
const HEALTHY_POLL_MS = 8_000;
const DEGRADED_POLL_MS = 1_000;
const RECONNECT_GRACE_MS = 1_500;

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
  transportMode: "connecting" | "sse" | "polling";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePriceFeed(connId?: string): PriceFeedState {
  const [state, setState] = useState<PriceFeedState>({
    prices:      {},
    forming:     {},
    lastClose:   null,
    symbols:     [],
    isConnected: false,
    transportMode: "connecting",
  });

  const esRef      = useRef<EventSource | null>(null);
  const backoffRef = useRef<number>(1_000);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventAtRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const reconnectSeqRef = useRef(0);
  const stalePollsRef = useRef(0);

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

  const clearReconnectTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPollTimer = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback((delay: number, poller: () => void) => {
    clearPollTimer();
    pollRef.current = setTimeout(poller, delay);
  }, [clearPollTimer]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const qs  = connId ? `?conn_id=${encodeURIComponent(connId)}` : "";
    const nonce = `stream_seq=${reconnectSeqRef.current}`;
    const url = `/api/stream${qs ? `${qs}&${nonce}` : `?${nonce}`}`;
    const es  = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      backoffRef.current = 1_000;
      stalePollsRef.current = 0;
      lastEventAtRef.current = Date.now();
      setState(s => ({ ...s, isConnected: true, transportMode: "sse" }));
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      if (!mountedRef.current) return;
      setState(s => ({
        ...s,
        isConnected: false,
        transportMode: Object.keys(s.prices).length > 0 ? "polling" : "connecting",
      }));
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 30_000);
      clearReconnectTimer();
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
          transportMode: "sse",
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
          isConnected: true,
          transportMode: "sse",
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
          isConnected: true,
          transportMode: "sse",
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
          setState(s => ({ ...s, isConnected: true, transportMode: "sse", lastClose: { symbol: d.symbol, bar: d.bar } }));
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
          setState(s => ({ ...s, isConnected: true, transportMode: "sse", symbols: d.symbols! }));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("heartbeat", () => {
      lastEventAtRef.current = Date.now();
      if (!mountedRef.current) return;
      setState(s => ({ ...s, isConnected: true, transportMode: "sse" }));
    });

  }, [acceptsConn, clearReconnectTimer, connId]);

  const refreshStream = useCallback(() => {
    clearReconnectTimer();
    esRef.current?.close();
    esRef.current = null;
    if (!mountedRef.current) return;
    setState(s => ({ ...s, isConnected: false, transportMode: Object.keys(s.prices).length > 0 ? "polling" : "connecting" }));
    reconnectSeqRef.current += 1;
    timerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      connect();
    }, RECONNECT_GRACE_MS);
  }, [clearReconnectTimer, connect]);

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
        const newest = newestTs(best.prices);
        if (newest > 0) {
          lastEventAtRef.current = Math.max(lastEventAtRef.current, newest);
        }
        setState(s => ({
          ...s,
          prices: { ...s.prices, ...best.prices },
          symbols: best.symbols?.length ? best.symbols : s.symbols,
          isConnected: true,
          transportMode: streamHealthy ? "sse" : "polling",
        }));
      }

      const eventAge = Date.now() - lastEventAtRef.current;
      const streamHealthy = esRef.current && eventAge <= STREAM_STALE_MS;
      if (streamHealthy) {
        stalePollsRef.current = 0;
      } else {
        stalePollsRef.current += 1;
        if (stalePollsRef.current >= 2) {
          stalePollsRef.current = 0;
          refreshStream();
        }
      }

      schedulePoll(streamHealthy ? HEALTHY_POLL_MS : DEGRADED_POLL_MS, () => {
        void pollPrices();
      });
    } catch {
      const eventAge = Date.now() - lastEventAtRef.current;
      if (eventAge > STREAM_STALE_MS) {
        refreshStream();
      }
      schedulePoll(DEGRADED_POLL_MS, () => {
        void pollPrices();
      });
    }
  }, [connId, fetchDirectRelayPrices, newestTs, refreshStream, schedulePoll]);

  useEffect(() => {
    setState({
      prices: {},
      forming: {},
      lastClose: null,
      symbols: [],
      isConnected: false,
      transportMode: "connecting",
    });
    lastEventAtRef.current = Date.now();
  }, [connId]);

  useEffect(() => {
    mountedRef.current = true;
    lastEventAtRef.current = Date.now();
    stalePollsRef.current = 0;
    connect();
    schedulePoll(DEGRADED_POLL_MS, () => {
      void pollPrices();
    });
    return () => {
      mountedRef.current = false;
      esRef.current?.close();
      esRef.current = null;
      clearReconnectTimer();
      clearPollTimer();
    };
  }, [clearPollTimer, clearReconnectTimer, connect, pollPrices, schedulePoll]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if ((Date.now() - lastEventAtRef.current) > STREAM_STALE_MS) {
        refreshStream();
        schedulePoll(DEGRADED_POLL_MS, () => {
          void pollPrices();
        });
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [pollPrices, refreshStream, schedulePoll]);

  return state;
}
