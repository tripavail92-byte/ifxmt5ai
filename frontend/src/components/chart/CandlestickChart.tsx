"use client";

import { useEffect, useRef, useCallback, useState } from "react";
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

export interface OHLCBar {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

// CandleBar from usePriceFeed (1m raw bar, epoch seconds)
export interface RawCandleBar {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

export interface CandlestickChartProps {
  sl?: number;
  tp?: number;
  entryPrice?: number;
  symbol?: string;
  className?: string;
  // Live feed props (Sprint 5)
  liveSymbol?: string;            // e.g. "BTCUSDm" — enables live feed
    connId?: string;                // optional connection filter
  forming?: Record<string, RawCandleBar>;    // from usePriceFeed
  lastClose?: { symbol: string; bar: RawCandleBar } | null;  // from usePriceFeed
}

// ─── Timeframes ───────────────────────────────────────────────────────────────

const TIMEFRAMES = ["M1", "M5", "M15", "H1", "H4", "D1"] as const;
type TF = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<TF, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

const TF_VOLATILITY: Record<TF, number> = {
  M1: 0.00025,
  M5: 0.00045,
  M15: 0.0008,
  H1: 0.0015,
  H4: 0.0035,
  D1: 0.0080,
};

// Map chart TF label → API tf param
const TF_API: Record<TF, string> = {
  M1: "1m", M5: "5m", M15: "15m", H1: "1h", H4: "4h", D1: "1d",
};

// Slot-snap a 1m bar to the active TF slot
function snapToTf(bar: RawCandleBar, tfSec: number): OHLCBar {
  return {
    time:  (Math.floor(bar.t / tfSec) * tfSec) as Time,
    open:  bar.o, high: bar.h, low: bar.l, close: bar.c,
  };
}

// ─── Seed data generator ──────────────────────────────────────────────────────

function generateBars(count: number, tf: TF): OHLCBar[] {
  const secs = TF_SECONDS[tf];
  const vol = TF_VOLATILITY[tf];
  // Align to a clean candle boundary
  const now = Math.floor(Date.now() / 1000 / secs) * secs;
  const start = now - (count - 1) * secs;

  const bars: OHLCBar[] = [];
  let price = 1.0852;

  for (let i = 0; i < count; i++) {
    const open = price;
    const drift = (Math.random() - 0.49) * vol * 2;
    const close = Math.max(0.00001, open + drift);
    const range = Math.abs(drift) * (1.15 + Math.random() * 0.7);
    const high = Math.max(open, close) + range * 0.4;
    const low = Math.min(open, close) - range * 0.4;

    bars.push({
      time: (start + i * secs) as Time,
      open: +open.toFixed(5),
      high: +high.toFixed(5),
      low: +low.toFixed(5),
      close: +close.toFixed(5),
    });
    price = close;
  }
  return bars;
}

// Pre-generate seed data for each TF once per module load
const SEED_DATA: Record<TF, OHLCBar[]> = {
  M1: generateBars(200, "M1"),
  M5: generateBars(200, "M5"),
  M15: generateBars(200, "M15"),
  H1: generateBars(200, "H1"),
  H4: generateBars(200, "H4"),
  D1: generateBars(200, "D1"),
};

// ─── Chart colours (matches dark terminal theme) ──────────────────────────────

const COLORS = {
  background: "#0c0c0c",
  gridLine: "#1a1a1a",
  text: "#9ca3af",
  border: "#2a2a2a",
  crosshair: "#3f3f3f",
  upBody: "#26a69a",
  downBody: "#ef5350",
  sl: "#ef5350",
  tp: "#26a69a",
  entry: "#3b82f6",
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
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const slLineRef    = useRef<IPriceLine | null>(null);
  const tpLineRef    = useRef<IPriceLine | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const lastHistoryCountRef = useRef<number>(0);
  const lastBarTimeRef = useRef<number>(0); // tracks time of series' last bar for update guards

  const [activeTf, setActiveTf] = useState<TF>(() =>
    // Default M15 for live (shows bars quickly); H1 for seed data
    typeof window !== "undefined" &&
    localStorage.getItem("ifx_chart_tf") as TF | null || "M15"
  );
  const [hasLiveData, setHasLiveData] = useState(false);
  const hasLiveDataRef = useRef(false);
  // Incremented by the retry timer to re-trigger the fetch effect
  const [fetchRevision, setFetchRevision] = useState(0);

  useEffect(() => {
    hasLiveDataRef.current = hasLiveData;
  }, [hasLiveData]);

  // ── Retry fetching history every 30s until real data arrives ──────────────
  useEffect(() => {
    if (!liveSymbol) return;
    const id = setInterval(() => {
      if (!hasLiveDataRef.current) {
        setFetchRevision(r => r + 1);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [liveSymbol]);

  // ── Mount / unmount chart ──────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.background },
        textColor: COLORS.text,
        fontFamily: "'Inter', 'SF Pro Display', sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.gridLine },
        horzLines: { color: COLORS.gridLine },
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
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.upBody,
      downColor: COLORS.downBody,
      borderUpColor: COLORS.upBody,
      borderDownColor: COLORS.downBody,
      wickUpColor: COLORS.upBody,
      wickDownColor: COLORS.downBody,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const seedH1 = SEED_DATA["H1"];
    series.setData(seedH1 as CandlestickData[]);
    lastBarTimeRef.current = seedH1.length ? seedH1[seedH1.length - 1].time as number : 0;
    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      slLineRef.current = null;
      tpLineRef.current = null;
      entryLineRef.current = null;
    };
  }, []); // run once on mount

  // ── Timeframe switch ───────────────────────────────────────────────────────
  const switchTf = useCallback((tf: TF) => {
    setActiveTf(tf);
    try { localStorage.setItem("ifx_chart_tf", tf); } catch { /* ignore */ }
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    // While waiting for the live fetch, immediately show seed data for this TF
    // so the timeframe switch feels instant. The fetch effect will replace
    // it with real bars when they arrive (incoming > 3).
    if (lastHistoryCountRef.current <= 3) {
      // No real history yet — show placeholder seed for the selected TF
      const seedTf = SEED_DATA[tf];
      series.setData(seedTf as CandlestickData[]);
      lastBarTimeRef.current = seedTf.length ? seedTf[seedTf.length - 1].time as number : 0;
      lastHistoryCountRef.current = 0; // mark as placeholder so fetch can replace
      chart.timeScale().fitContent();
    } else if (!liveSymbol) {
      // No live symbol at all — always use seed data
      const seedTf = SEED_DATA[tf];
      series.setData(seedTf as CandlestickData[]);
      lastBarTimeRef.current = seedTf.length ? seedTf[seedTf.length - 1].time as number : 0;
      chart.timeScale().fitContent();
    }
    // When we have real history (lastHistoryCountRef > 3), the fetch effect
    // will load the real bars for the new TF automatically.
  }, [liveSymbol]);

  // ── Fetch live candle history from Railway ─────────────────────────────────
  useEffect(() => {
    if (!liveSymbol) return;
    const series = seriesRef.current;
    const chart  = chartRef.current;
    if (!series || !chart) return;

    // Capture activeTf in a local variable so stale closures don't overwrite
    const tf = activeTf;
    const ac = new AbortController();

    const apiTf = TF_API[tf];
    const connQ = connId ? `&conn_id=${encodeURIComponent(connId)}` : "";
    const url   = `/api/candles?symbol=${encodeURIComponent(liveSymbol)}&tf=${apiTf}&count=1500${connQ}`;

    fetch(url, { signal: ac.signal })
      .then(r => r.json())
      .then((data: { bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> }) => {
        if (ac.signal.aborted || !seriesRef.current) return;

        const incoming = data.bars?.length ?? 0;
        const previous = lastHistoryCountRef.current;

        // If the API returned ≤3 bars, we have no real history yet.
        // Either keep current data (if already healthy) or show proper seed
        // data so the chart at least reflects the correct timeframe.
        if (incoming <= 3) {
          if (previous > 3) return; // already have good data — don't downgrade
          // Show seed data for the active TF so all TFs look different
          const seed = SEED_DATA[tf];
          series.setData(seed as CandlestickData[]);
          lastBarTimeRef.current = seed.length ? seed[seed.length - 1].time as number : 0;
          chart.timeScale().fitContent();
          return;
        }

        // We have real history — load it
        const mapped: OHLCBar[] = data.bars.map(b => ({
          time:  b.t as Time,
          open:  b.o,
          high:  b.h,
          low:   b.l,
          close: b.c,
        }));
        seriesRef.current.setData(mapped as CandlestickData[]);
        lastHistoryCountRef.current = incoming;
        lastBarTimeRef.current = mapped.length ? mapped[mapped.length - 1].time as number : 0;
        chartRef.current?.timeScale().fitContent();
        setHasLiveData(true);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        // Network error — show seed for this TF if no live data yet
        if (!hasLiveDataRef.current) {
          const seed = SEED_DATA[tf];
          series.setData(seed as CandlestickData[]);
          lastBarTimeRef.current = seed.length ? seed[seed.length - 1].time as number : 0;
          chart.timeScale().fitContent();
        }
      });

    // Cancel in-flight request if symbol/TF/connId changes before it resolves
    return () => { ac.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSymbol, activeTf, connId, fetchRevision]);

  // ── Apply incoming forming (live tick) update ──────────────────────────────
  useEffect(() => {
    if (!liveSymbol || !forming) return;
    const bar = forming[liveSymbol];
    if (!bar) return;
    const series = seriesRef.current;
    if (!series) return;
    const tfSec = TF_SECONDS[activeTf];
    const snappedForming = snapToTf(bar, tfSec);
    try {
      series.update(snappedForming as CandlestickData);
      lastBarTimeRef.current = Math.max(lastBarTimeRef.current, snappedForming.time as number);
    } catch { /* stale or out-of-order forming bar — skip */ }
    if (!hasLiveDataRef.current) {
      setHasLiveData(true);
    }
  }, [liveSymbol, forming, activeTf]);

  // ── Apply candle close ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!liveSymbol || !lastClose) return;
    if (lastClose.symbol !== liveSymbol) return;
    const series = seriesRef.current;
    if (!series) return;
    const tfSec = TF_SECONDS[activeTf];
    const snappedClose = snapToTf(lastClose.bar, tfSec);
    const closeTime = snappedClose.time as number;
    // Skip if this close belongs to a bar that's no longer the last in the series.
    // This happens at TF boundaries: e.g. the 13:59 close snaps to 13:45 M15
    // after the chart has already appended a 14:00 forming bar.
    if (closeTime < lastBarTimeRef.current) return;
    try {
      series.update(snappedClose as CandlestickData);
    } catch { /* skip */ }
    if (!hasLiveDataRef.current) {
      setHasLiveData(true);
    }
  }, [liveSymbol, lastClose, activeTf]);

  // ── SL price line ──────────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (slLineRef.current) {
      series.removePriceLine(slLineRef.current);
      slLineRef.current = null;
    }
    if (sl && sl > 0) {
      slLineRef.current = series.createPriceLine({
        price: sl,
        color: COLORS.sl,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "SL",
      });
    }
  }, [sl]);

  // ── TP price line ──────────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (tpLineRef.current) {
      series.removePriceLine(tpLineRef.current);
      tpLineRef.current = null;
    }
    if (tp && tp > 0) {
      tpLineRef.current = series.createPriceLine({
        price: tp,
        color: COLORS.tp,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TP",
      });
    }
  }, [tp]);

  // ── Entry price line ───────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (entryLineRef.current) {
      series.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    if (entryPrice && entryPrice > 0) {
      entryLineRef.current = series.createPriceLine({
        price: entryPrice,
        color: COLORS.entry,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Entry",
      });
    }
  }, [entryPrice]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0c0c0c] border border-[#2a2a2a] rounded-t-lg">
        <span className="font-mono font-semibold text-sm text-white tracking-wide">
          {liveSymbol ?? symbol}
          {liveSymbol && hasLiveData ? (
            <span className="ml-2 text-xs font-normal text-emerald-500 animate-pulse">● LIVE</span>
          ) : liveSymbol ? (
            <span className="ml-2 text-xs font-normal text-yellow-500">⟳ connecting…</span>
          ) : (
            <span className="ml-2 text-xs font-normal text-gray-500">seed data · live feed coming in Phase 1.5</span>
          )}
        </span>
        <div className="flex gap-0.5">
          {TIMEFRAMES.map((tf) => (
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

      {/* Canvas container */}
      <div
        ref={containerRef}
        className="w-full border-x border-b border-[#2a2a2a] rounded-b-lg"
        style={{ height: 300, minHeight: 300 }}
      />

      {/* Legend: active price lines */}
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
