"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
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
  symbol?: string;
  className?: string;
  liveSymbol?: string;
  connId?: string;
  forming?: Record<string, RawCandleBar>;
  lastClose?: { symbol: string; bar: RawCandleBar } | null;
}

// ─── Timeframes ───────────────────────────────────────────────────────────────

const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4", "D1"] as const;
type TF = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<TF, number> = {
  M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400,
};

const TF_API: Record<TF, string> = {
  M1: "1m", M5: "5m", M15: "15m", H1: "1h", H4: "4h", D1: "1d",
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

// ─── Component ────────────────────────────────────────────────────────────────

export function CandlestickChart({
  sl,
  tp,
  entryPrice,
  symbol = "EURUSD",
  className = "",
  liveSymbol,
  connId,
  forming,
  lastClose,
}: CandlestickChartProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  const seriesRef     = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const slLineRef     = useRef<IPriceLine | null>(null);
  const tpLineRef     = useRef<IPriceLine | null>(null);
  const entryLineRef  = useRef<IPriceLine | null>(null);
  // Time of the last bar in the series — used to guard series.update() calls
  const lastBarTimeRef = useRef<number>(0);
  // True once ≥1 real historical bars have been loaded from the API
  const hasRealDataRef = useRef<boolean>(false);

  const [activeTf, setActiveTf] = useState<TF>(() => {
    if (typeof window === "undefined") return "M1";
    return (localStorage.getItem("ifx_chart_tf") as TF | null) ?? "M1";
  });
  const [isLive, setIsLive] = useState(false);
  // Bumped by the retry timer and by switchTf to trigger an immediate re-fetch
  const [fetchTick, setFetchTick] = useState(0);

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
    };
  }, []); // run once

  // ── Update price format when symbol changes ────────────────────────────────
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: priceFormat(liveSymbol ?? symbol) });
  }, [liveSymbol, symbol]);

  // ── Retry timer — re-fires fetch every 3s until real history loads ────────
  useEffect(() => {
    if (!liveSymbol) return;
    const id = setInterval(() => {
      if (!hasRealDataRef.current) {
        setFetchTick(n => n + 1);
      }
    }, 3_000);
    return () => clearInterval(id);
  }, [liveSymbol]);

  // ── Fetch candle history ──────────────────────────────────────────────────
  useEffect(() => {
    if (!liveSymbol) return;
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series || !chart) return;

    const tf  = activeTf;
    const ac  = new AbortController();
    const connQ = connId ? `&conn_id=${encodeURIComponent(connId)}` : "";
    const url = `/api/candles?symbol=${encodeURIComponent(liveSymbol)}&tf=${TF_API[tf]}&count=1500${connQ}`;

    fetch(url, { signal: ac.signal })
      .then(r => r.json())
      .then((data: { bars?: RawCandleBar[] }) => {
        if (ac.signal.aborted) return;
        const bars = data.bars ?? [];
        // Nothing from API yet — leave chart as-is, retry timer will try again
        if (bars.length === 0) return;

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
        lastBarTimeRef.current = mapped[mapped.length - 1].time as number;
        chartRef.current?.timeScale().fitContent();
        hasRealDataRef.current = true;
        setIsLive(true);
      })
      .catch(err => {
        if ((err as Error)?.name !== "AbortError") {
          console.warn("[CandlestickChart] fetch error:", err);
        }
      });

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSymbol, activeTf, connId, fetchTick]);

  // ── Forming bar (live tick every ~150ms) ─────────────────────────────────
  useEffect(() => {
    if (!liveSymbol || !forming) return;
    const bar = forming[liveSymbol];
    if (!bar) return;
    const series = seriesRef.current;
    if (!series) return;

    const tfSec    = TF_SECONDS[activeTf];
    const slotTime = (Math.floor(bar.t / tfSec) * tfSec) as Time;
    try {
      series.update({ time: slotTime, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
      lastBarTimeRef.current = Math.max(lastBarTimeRef.current, slotTime as number);
    } catch { /* out-of-order or before setData — ignore */ }

    if (!isLive) setIsLive(true);
  }, [liveSymbol, forming, activeTf, isLive]);

  // ── Completed candle (bar close event) ───────────────────────────────────
  useEffect(() => {
    if (!liveSymbol || !lastClose || lastClose.symbol !== liveSymbol) return;
    const series = seriesRef.current;
    if (!series) return;

    const tfSec    = TF_SECONDS[activeTf];
    const slotTime = Math.floor(lastClose.bar.t / tfSec) * tfSec;
    // Skip if the series has already moved past this slot (can happen at TF boundaries)
    if (slotTime < lastBarTimeRef.current) return;
    try {
      series.update({
        time: slotTime as Time,
        open: lastClose.bar.o, high: lastClose.bar.h,
        low:  lastClose.bar.l, close: lastClose.bar.c,
      });
    } catch { /* skip */ }
  }, [liveSymbol, lastClose, activeTf]);

  // ── TF switch ─────────────────────────────────────────────────────────────
  function switchTf(tf: TF) {
    // Clear series so the user sees a blank slate while the new TF loads
    seriesRef.current?.setData([]);
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
