"use client";

/**
 * usePriceFeed — WebSocket hook for live MT5 price and candle data.
 *
 * Connects to GET /ws/stream via the custom Node server WebSocket bridge.
 * Reconnects automatically with exponential back-off on disconnect.
 *
 * Usage:
 *   const { prices, forming, lastClose, symbols, isConnected } = usePriceFeed();
 */

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SERVER_PRICE_AGE_MS = 2_000;
const SELECTED_SYMBOL_MAX_AGE_MS = 1_500;
const STREAM_STALE_MS = 3_500;
const HEALTHY_POLL_MS = 3_000;
const DEGRADED_POLL_MS = 500;
const SELECTED_SYMBOL_POLL_MS = 750;
const RECONNECT_GRACE_MS = 750;

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
  transportMode: "connecting" | "ws" | "polling";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePriceFeed(connId?: string, selectedSymbol?: string): PriceFeedState {
  const [state, setState] = useState<PriceFeedState>({
    prices:      {},
    forming:     {},
    lastClose:   null,
    symbols:     [],
    isConnected: false,
    transportMode: "connecting",
  });

  const wsRef      = useRef<WebSocket | null>(null);
  const backoffRef = useRef<number>(1_000);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const pollPricesRef = useRef<() => Promise<void>>(async () => {});
  const pricesRef = useRef<Record<string, PriceSnapshot>>({});
  const lastTransportEventAtRef = useRef<number>(0);
  const lastPriceEventAtRef = useRef<number>(0);
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

  const mergeFresherPrices = useCallback((
    current: Record<string, PriceSnapshot>,
    incoming?: Record<string, PriceSnapshot>
  ) => {
    if (!incoming) return current;
    const merged = { ...current };
    for (const [symbol, nextSnap] of Object.entries(incoming)) {
      if (!nextSnap) continue;
      const prevSnap = merged[symbol];
      const prevTs = prevSnap?.ts_ms ?? 0;
      const nextTs = nextSnap.ts_ms ?? 0;
      if (!prevSnap || nextTs >= prevTs) {
        merged[symbol] = nextSnap;
      }
    }
    return merged;
  }, []);

  const selectedPriceTs = useCallback((prices?: Record<string, PriceSnapshot>) => {
    if (!selectedSymbol) return 0;
    return prices?.[selectedSymbol]?.ts_ms ?? 0;
  }, [selectedSymbol]);

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

  const clearPingTimer = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback((delay: number, poller: () => void) => {
    clearPollTimer();
    pollRef.current = setTimeout(poller, delay);
  }, [clearPollTimer]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const search = new URLSearchParams();
    if (connId) search.set("conn_id", connId);
    search.set("stream_seq", String(reconnectSeqRef.current));
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/stream?${search.toString()}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      backoffRef.current = 1_000;
      stalePollsRef.current = 0;
      lastTransportEventAtRef.current = Date.now();
      setState(s => ({ ...s, isConnected: true, transportMode: "ws" }));
      clearPingTimer();
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    };

    const scheduleReconnect = () => {
      clearPingTimer();
      wsRef.current = null;
      if (!mountedRef.current) return;
      setState(s => ({
        ...s,
        isConnected: false,
        transportMode: Object.keys(s.prices).length > 0 ? "polling" : "connecting",
      }));
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, 30_000);
      clearReconnectTimer();
      timerRef.current = setTimeout(() => {
        connectRef.current();
      }, delay);
    };

    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };

    ws.onclose = () => {
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const d = JSON.parse(event.data as string) as {
          type?: string;
          connection_id?: string;
          prices?: Record<string, PriceSnapshot>;
          forming?: Record<string, CandleBar>;
          symbols?: string[];
          symbol?: string;
          bar?: CandleBar;
        };

        if (d.type !== "pong" && !acceptsConn(d.connection_id)) return;
        lastTransportEventAtRef.current = Date.now();

        if (d.type === "init") {
          const newest = newestTs(d.prices);
          if (newest > 0) lastPriceEventAtRef.current = Math.max(lastPriceEventAtRef.current, newest);
          setState(s => ({
            ...s,
            isConnected: true,
            transportMode: "ws",
            prices: mergeFresherPrices(s.prices, d.prices),
            forming: d.forming ?? s.forming,
            symbols: d.symbols?.length ? d.symbols : s.symbols,
          }));
          return;
        }

        if (d.type === "prices") {
          const newest = newestTs(d.prices);
          if (newest > 0) lastPriceEventAtRef.current = Math.max(lastPriceEventAtRef.current, newest);
          setState(s => ({
            ...s,
            isConnected: true,
            transportMode: "ws",
            prices: mergeFresherPrices(s.prices, d.prices),
          }));
          return;
        }

        if (d.type === "candle_update") {
          setState(s => ({
            ...s,
            isConnected: true,
            transportMode: "ws",
            forming: { ...s.forming, ...(d.forming ?? {}) },
          }));
          return;
        }

        if (d.type === "candle_close") {
          if (d.symbol && d.bar) {
            setState(s => ({ ...s, isConnected: true, transportMode: "ws", lastClose: { symbol: d.symbol!, bar: d.bar! } }));
          }
          return;
        }

        if (d.type === "connected") {
          if (d.symbols?.length) {
            setState(s => ({ ...s, isConnected: true, transportMode: "ws", symbols: d.symbols! }));
          }
          return;
        }

        if (d.type === "heartbeat" || d.type === "pong") {
          setState(s => ({ ...s, isConnected: true, transportMode: "ws" }));
        }
      } catch {
        // Ignore malformed messages and keep the polling fallback alive.
      }
    };

  }, [acceptsConn, clearPingTimer, clearReconnectTimer, connId, mergeFresherPrices]);

  const refreshStream = useCallback(() => {
    clearReconnectTimer();
    clearPingTimer();
    wsRef.current?.close();
    wsRef.current = null;
    if (!mountedRef.current) return;
    setState(s => ({ ...s, isConnected: false, transportMode: Object.keys(s.prices).length > 0 ? "polling" : "connecting" }));
    reconnectSeqRef.current += 1;
    timerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      connect();
    }, RECONNECT_GRACE_MS);
  }, [clearPingTimer, clearReconnectTimer, connect]);

  const pollPrices = useCallback(async () => {
    try {
      const currentPrices = pricesRef.current;
      const selectedTs = selectedPriceTs(currentPrices);
      const selectedQuoteIsStale = Boolean(selectedSymbol)
        && (!selectedTs || (Date.now() - selectedTs) > SELECTED_SYMBOL_MAX_AGE_MS);
      const search = new URLSearchParams();
      if (connId) search.set("conn_id", connId);
      if (selectedQuoteIsStale && selectedSymbol) search.set("symbol", selectedSymbol);
      const qs = search.toString() ? `?${search.toString()}` : "";
      const resp = await fetch(`/api/prices${qs}`, { cache: "no-store" });
      const data = resp.ok ? await resp.json() as {
        prices?: Record<string, PriceSnapshot>;
        symbols?: string[];
      } : null;

      const serverNewest = newestTs(data?.prices);
      const serverIsStale = !serverNewest || (Date.now() - serverNewest) > MAX_SERVER_PRICE_AGE_MS;
      const transportAge = Date.now() - lastTransportEventAtRef.current;
      const streamHealthy = Boolean(wsRef.current && wsRef.current.readyState === WebSocket.OPEN) && transportAge <= STREAM_STALE_MS;

      if (!mountedRef.current) return;

      if (data?.prices && Object.keys(data.prices).length > 0) {
        const newest = newestTs(data.prices);
        if (newest > 0) {
          lastPriceEventAtRef.current = Math.max(lastPriceEventAtRef.current, newest);
        }
        setState(s => {
          const mergedPrices = mergeFresherPrices(s.prices, data.prices);
          return {
            ...s,
            prices: mergedPrices,
            symbols: data.symbols?.length ? data.symbols : s.symbols,
            isConnected: true,
            transportMode: streamHealthy ? "ws" : "polling",
          };
        });
      }

      const quoteTs = Math.max(lastPriceEventAtRef.current, selectedPriceTs(data?.prices), selectedPriceTs(currentPrices));
      const quoteIsStale = Boolean(selectedSymbol)
        && (!quoteTs || (Date.now() - quoteTs) > SELECTED_SYMBOL_MAX_AGE_MS);

      if (streamHealthy) {
        stalePollsRef.current = 0;
      } else {
        stalePollsRef.current += 1;
        if (stalePollsRef.current >= 2) {
          stalePollsRef.current = 0;
          refreshStream();
        }
      }

      const nextPollMs = quoteIsStale
        ? SELECTED_SYMBOL_POLL_MS
        : streamHealthy && !serverIsStale
          ? HEALTHY_POLL_MS
          : DEGRADED_POLL_MS;

      schedulePoll(nextPollMs, () => {
        void pollPricesRef.current();
      });
    } catch {
      const transportAge = Date.now() - lastTransportEventAtRef.current;
      if (transportAge > STREAM_STALE_MS) {
        refreshStream();
      }
      schedulePoll(DEGRADED_POLL_MS, () => {
        void pollPricesRef.current();
      });
    }
  }, [connId, mergeFresherPrices, newestTs, refreshStream, schedulePoll, selectedPriceTs, selectedSymbol]);

  useEffect(() => {
    pricesRef.current = state.prices;
  }, [state.prices]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    pollPricesRef.current = pollPrices;
  }, [pollPrices]);

  useEffect(() => {
    setState({
      prices: {},
      forming: {},
      lastClose: null,
      symbols: [],
      isConnected: false,
      transportMode: "connecting",
    });
    pricesRef.current = {};
    lastTransportEventAtRef.current = Date.now();
    lastPriceEventAtRef.current = 0;
  }, [connId]);

  useEffect(() => {
    if (!mountedRef.current) return;
    schedulePoll(0, () => {
      void pollPricesRef.current();
    });
  }, [schedulePoll, selectedSymbol]);

  useEffect(() => {
    mountedRef.current = true;
    lastTransportEventAtRef.current = Date.now();
    lastPriceEventAtRef.current = 0;
    stalePollsRef.current = 0;
    connect();
    schedulePoll(DEGRADED_POLL_MS, () => {
      void pollPrices();
    });
    return () => {
      mountedRef.current = false;
      clearPingTimer();
      wsRef.current?.close();
      wsRef.current = null;
      clearReconnectTimer();
      clearPollTimer();
    };
  }, [clearPingTimer, clearPollTimer, clearReconnectTimer, connect, pollPrices, schedulePoll]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if ((Date.now() - lastTransportEventAtRef.current) > STREAM_STALE_MS) {
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
