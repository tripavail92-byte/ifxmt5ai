"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  BaselineSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type IPriceLine,
} from "lightweight-charts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawCandleBar {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

export interface CandlestickChartProps {
  sl?: number;
  tp?: number;
  entryPrice?: number;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  symbol?: string;
  className?: string;
  liveSymbol?: string;
  connId?: string;
  forming?: Record<string, RawCandleBar>;
  lastClose?: { symbol: string; bar: RawCandleBar } | null;
}

// ─── Timeframes ───────────────────────────────────────────────────────────────

const TIMEFRAMES = ["M1", "M3", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
type TF = (typeof TIMEFRAMES)[number];

const TF_API: Record<TF, string> = {
  M1: "1m", M3: "3m", M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "1d",
};

// ─── Symbol precision ────────────────────────────────────────────────────────

function getDigits(sym: string): number {
  const s = sym.toUpperCase();
  if (/JPY/.test(s))           return 3;
  if (/BTC|ETH/.test(s))       return 2;
  if (/XAU|XAG|OIL/.test(s))  return 2;
  return 5;
}

function priceFormat(sym: string) {
  const p = getDigits(sym);
  return { type: "price" as const, precision: p, minMove: Math.pow(10, -p) };
}

// ─── Chart colours ────────────────────────────────────────────────────────────

const COLORS = {
  bg:        "#0c0c0c",
  grid:      "#1a1a1a",
  text:      "#9ca3af",
  border:    "#2a2a2a",
  crosshair: "#3f3f3f",
  up:        "#26a69a",
  down:      "#ef5350",
  sl:        "#ef5350",
  tp:        "#26a69a",
  entry:     "#3b82f6",
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CandlestickChart({
  sl,
  tp,
  entryPrice,
  entryZoneLow,
  entryZoneHigh,
  symbol = "EURUSD",
  className = "",
  liveSymbol,
  connId,
}: CandlestickChartProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const seriesRef     = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const slLineRef     = useRef<IPriceLine | null>(null);
  const tpLineRef     = useRef<IPriceLine | null>(null);
  const entryLineRef  = useRef<IPriceLine | null>(null);
  const entryBandRef  = useRef<ISeriesApi<"Baseline"> | null>(null);
  const historyRef    = useRef<CandlestickData[]>([]);
  // Time of the last bar in the series — used to guard series.update() calls
  const lastBarTimeRef = useRef<number>(0);
  // True once ≥1 real historical bars have been loaded from the API
  const hasRealDataRef = useRef<boolean>(false);

  const [activeTf, setActiveTf] = useState<TF>(() => {
    if (typeof window === "undefined") return "M5";
    const raw = localStorage.getItem("ifx_chart_tf");
    const stored = (raw as TF | null) ?? null;
    return stored && (TIMEFRAMES as readonly string[]).includes(stored) ? stored : "M5";
  });
  const [isLive, setIsLive] = useState(false);
  // Bumped by the retry timer and by switchTf to trigger an immediate re-fetch
  const [fetchTick, setFetchTick] = useState(0);
  // Bumped after setData() so overlays can refresh off the same timebase
  const [historyVersion, setHistoryVersion] = useState(0);

  const HISTORY_COUNT = 200; // must roughly match engine structure window
  const LOCAL_RELAY_RETRY_COOLDOWN_MS = 30_000;
  const localRelayBlockedUntilRef = useRef<number>(0);
  const localRelayWarnedRef = useRef<boolean>(false);
  const ENABLE_LOCAL_RELAY_FALLBACK = process.env.NEXT_PUBLIC_ENABLE_LOCAL_RELAY_FALLBACK !== "0";

  // ── Mount chart (once) ────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.bg },
        textColor: COLORS.text,
        fontFamily: "'Inter', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1f2937",
        },
        horzLine: {
          color: COLORS.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#1f2937",
        },
      },
      rightPriceScale: {
        borderColor: COLORS.border,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: COLORS.border,
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:        COLORS.up,
      downColor:      COLORS.down,
      borderUpColor:  COLORS.up,
      borderDownColor:COLORS.down,
      wickUpColor:    COLORS.up,
      wickDownColor:  COLORS.down,
      priceFormat:    priceFormat(liveSymbol ?? symbol),
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    // Force the chart to repaint whenever the container is resized
    // (lightweight-charts autoSize handles width but needs a nudge on height change)
    const ro = new ResizeObserver(() => {
      chart.timeScale().fitContent();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
      slLineRef.current    = null;
      tpLineRef.current    = null;
      entryLineRef.current = null;
      entryBandRef.current = null;
    };
  }, []); // run once

  // ── Update price format when symbol changes ────────────────────────────────
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: priceFormat(liveSymbol ?? symbol) });
  }, [liveSymbol, symbol]);

  // ── Poll timer — re-fetch broker candles every 3s ─────────────────────────
  useEffect(() => {
    if (!liveSymbol) return;
    const id = setInterval(() => {
      setFetchTick(n => n + 1);
    }, 3_000);
    return () => clearInterval(id);
  }, [liveSymbol]);

  // ── Fetch candle history ──────────────────────────────────────────────────
  useEffect(() => {
    if (!liveSymbol || !connId) return;
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series || !chart) return;

    const tf  = activeTf;
    const ac  = new AbortController();
    const connQ = connId ? `&conn_id=${encodeURIComponent(connId)}` : "";

    const apiUrl = `/api/candles?symbol=${encodeURIComponent(liveSymbol)}&tf=${TF_API[tf]}&count=${HISTORY_COUNT}${connQ}`;
    const localRelayUrl = `http://127.0.0.1:8082/candles?symbol=${encodeURIComponent(liveSymbol)}&tf=${TF_API[tf]}&count=${HISTORY_COUNT}${connQ}`;

    const applyBars = (bars: RawCandleBar[]) => {
      if (ac.signal.aborted) return;
      if (!bars.length) return;

      const mapped: CandlestickData[] = bars.map(b => ({
        time:  b.t as Time,
        open:  b.o,
        high:  b.h,
        low:   b.l,
        close: b.c,
      }));

      const s = seriesRef.current;
      if (!s) return;
      s.setData(mapped);
      historyRef.current = mapped;
      setHistoryVersion(v => v + 1);
      lastBarTimeRef.current = mapped[mapped.length - 1].time as number;
      chartRef.current?.timeScale().fitContent();
      hasRealDataRef.current = true;
      setIsLive(true);
    };

    // Minimum bars Railway must return before we trust it as the sole source.
    // After a Railway redeploy the in-memory state resets and may hold only the
    // current forming bar (count=1). We always also query the local relay and
    // use whichever source returns more bars.
    const MIN_RAILWAY_BARS = 20;

    const load = async () => {
      let railwayBars: RawCandleBar[] = [];
      let relayBars:   RawCandleBar[] = [];

      // 1) Same-origin Railway API (state-first, avoids relay dependency)
      try {
        const r1 = await fetch(apiUrl, { signal: ac.signal, cache: "no-store" });
        const d1 = (await r1.json()) as { bars?: RawCandleBar[] };
        railwayBars = d1.bars ?? [];
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          console.warn("[CandlestickChart] /api/candles failed:", err);
        }
      }

      // 2) Local relay fallback (cooldown-aware)
      //    We pause retries briefly after a localhost connection failure to
      //    avoid flooding the console every poll tick when relay is offline.
      const shouldTryLocalRelay =
        ENABLE_LOCAL_RELAY_FALLBACK &&
        railwayBars.length < MIN_RAILWAY_BARS &&
        Date.now() >= localRelayBlockedUntilRef.current;

      if (shouldTryLocalRelay) {
        try {
          const r2 = await fetch(localRelayUrl, { signal: ac.signal, cache: "no-store" });
          const d2 = (await r2.json()) as { bars?: RawCandleBar[] };
          relayBars = d2.bars ?? [];
          localRelayBlockedUntilRef.current = 0;
          localRelayWarnedRef.current = false;
        } catch (err) {
          if ((err as Error)?.name !== "AbortError") {
            const now = Date.now();
            localRelayBlockedUntilRef.current = now + LOCAL_RELAY_RETRY_COOLDOWN_MS;
            if (!localRelayWarnedRef.current) {
              console.warn(
                `[CandlestickChart] localhost relay fetch failed; pausing retries for ${Math.round(LOCAL_RELAY_RETRY_COOLDOWN_MS / 1000)}s:`,
                err
              );
              localRelayWarnedRef.current = true;
            }
          }
        }
      }

      // Use whichever source has more bars
      const best = relayBars.length > railwayBars.length ? relayBars : railwayBars;
      if (best.length) applyBars(best);
    };

    void load();

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSymbol, activeTf, connId, fetchTick]);

  // ── TF switch ─────────────────────────────────────────────────────────────
  function switchTf(tf: TF) {
    // Clear series so the user sees a blank slate while the new TF loads
    seriesRef.current?.setData([]);
    historyRef.current = [];
    setHistoryVersion(v => v + 1);
    lastBarTimeRef.current = 0;
    hasRealDataRef.current = false;
    setActiveTf(tf);
    try { localStorage.setItem("ifx_chart_tf", tf); } catch { /* ignore */ }
    // Trigger immediate re-fetch for the new TF
    setFetchTick(n => n + 1);
  }

  // ── SL / TP / Entry price lines ───────────────────────────────────────────
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (slLineRef.current) { s.removePriceLine(slLineRef.current); slLineRef.current = null; }
    if (sl && sl > 0) {
      slLineRef.current = s.createPriceLine({
        price: sl, color: COLORS.sl, lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL",
      });
    }
  }, [sl]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (tpLineRef.current) { s.removePriceLine(tpLineRef.current); tpLineRef.current = null; }
    if (tp && tp > 0) {
      tpLineRef.current = s.createPriceLine({
        price: tp, color: COLORS.tp, lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP",
      });
    }
  }, [tp]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (entryLineRef.current) { s.removePriceLine(entryLineRef.current); entryLineRef.current = null; }
    if (entryPrice && entryPrice > 0) {
      entryLineRef.current = s.createPriceLine({
        price: entryPrice, color: COLORS.entry, lineWidth: 2,
        lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "Entry",
      });
    }
  }, [entryPrice]);

  // ── Entry zone shaded band (between zone_low and zone_high) ──────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const lowRaw = entryZoneLow;
    const highRaw = entryZoneHigh;

    const low = typeof lowRaw === "number" && Number.isFinite(lowRaw) ? lowRaw : null;
    const high = typeof highRaw === "number" && Number.isFinite(highRaw) ? highRaw : null;

    // Remove if not valid
    if (low === null || high === null || low <= 0 || high <= 0 || low === high) {
      if (entryBandRef.current) {
        chart.removeSeries(entryBandRef.current);
        entryBandRef.current = null;
      }
      return;
    }

    const zoneLow = Math.min(low, high);
    const zoneHigh = Math.max(low, high);

    if (!entryBandRef.current) {
      entryBandRef.current = chart.addSeries(BaselineSeries, {
        baseValue: { type: "price", price: zoneLow },
        topLineColor: COLORS.entry,
        topFillColor1: hexToRgba(COLORS.entry, 0.25),
        topFillColor2: hexToRgba(COLORS.entry, 0.05),
        bottomLineColor: "transparent",
        bottomFillColor1: "transparent",
        bottomFillColor2: "transparent",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    } else {
      entryBandRef.current.applyOptions({
        baseValue: { type: "price", price: zoneLow },
      });
    }

    const band = entryBandRef.current;
    if (!band) return;
    const candles = historyRef.current;
    if (candles.length === 0) {
      band.setData([]);
      return;
    }

    band.setData(
      candles.map((c) => ({ time: c.time as Time, value: zoneHigh }))
    );
  }, [entryZoneLow, entryZoneHigh, historyVersion]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0c0c0c] border border-[#2a2a2a] rounded-t-lg">
        <span className="font-mono font-semibold text-sm text-white tracking-wide">
          {liveSymbol ?? symbol}
          {isLive ? (
            <span className="ml-2 text-xs font-normal text-emerald-500 animate-pulse">● LIVE</span>
          ) : liveSymbol ? (
            <span className="ml-2 text-xs font-normal text-yellow-500">⟳ loading…</span>
          ) : null}
        </span>
        <div className="flex gap-0.5">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              type="button"
              onClick={() => switchTf(tf)}
              className={`px-2 py-0.5 text-xs font-medium rounded transition-colors ${
                activeTf === tf
                  ? "bg-orange-500 text-white"
                  : "text-gray-500 hover:text-white hover:bg-[#1e1e1e]"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Canvas — height scales with viewport: 220px mobile → 420px large screen */}
      <div
        ref={containerRef}
        className="w-full border-x border-b border-[#2a2a2a] rounded-b-lg"
        style={{ height: "clamp(220px, 40vh, 420px)" }}
      />

      {/* Legend */}
      <div className="flex items-center gap-4 px-1 mt-1 text-xs">
        {entryPrice && entryPrice > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-blue-500" />
            <span className="text-blue-400">Entry {entryPrice.toFixed(5)}</span>
          </span>
        )}
        {sl && sl > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-red-500" />
            <span className="text-red-400">SL {sl.toFixed(5)}</span>
          </span>
        )}
        {tp && tp > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-emerald-500" />
            <span className="text-emerald-400">TP {tp.toFixed(5)}</span>
          </span>
        )}
        <span className="ml-auto">
          <a
            href="https://www.tradingview.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-gray-700 hover:text-gray-500"
          >
            Charting by TradingView
          </a>
        </span>
      </div>
    </div>
  );
}
