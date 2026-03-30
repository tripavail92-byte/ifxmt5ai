"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  BaselineSeries,
  LineSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type Time,
  type IPriceLine,
} from "lightweight-charts";

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

const TIMEFRAMES = ["M1", "M3", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"] as const;
type TF = (typeof TIMEFRAMES)[number];

const TF_API: Record<TF, string> = {
  M1: "1m", M3: "3m", M5: "5m", M15: "15m", M30: "30m",
  H1: "1h", H4: "4h", D1: "1d", W1: "1w", MN: "1mo",
};

const TF_MINUTES: Record<TF, number> = {
  M1: 1, M3: 3, M5: 5, M15: 15, M30: 30, H1: 60,
  H4: 240, D1: 1440, W1: 10080, MN: 43200,
};

// ── Indicator config ─────────────────────────────────────────────────────────
export interface IndicatorConfig {
  ema9: boolean;
  ema21: boolean;
  bb: boolean;
}
const DEFAULT_INDICATORS: IndicatorConfig = { ema9: false, ema21: false, bb: false };
const STORAGE_KEY_INDICATORS = "ifx_chart_indicators";

const COLORS = {
  bg: "#0c0c0c",
  grid: "#1a1a1a",
  text: "#9ca3af",
  border: "#2a2a2a",
  crosshair: "#3f3f3f",
  up: "#26a69a",
  down: "#ef5350",
  sl: "#ef5350",
  tp: "#26a69a",
  entry: "#3b82f6",
};

function getDigits(sym: string): number {
  const s = sym.toUpperCase();
  if (/JPY/.test(s)) return 3;
  if (/BTC|ETH/.test(s)) return 2;
  if (/XAU|XAG/.test(s)) return 3;
  if (/OIL/.test(s)) return 2;
  return 5;
}

function priceFormat(sym: string) {
  const p = getDigits(sym);
  return { type: "price" as const, precision: p, minMove: Math.pow(10, -p) };
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function toTfSlot(epochSec: number, tf: TF): number {
  // Weekly: round down to Monday 00:00 UTC
  if (tf === "W1") {
    const d = new Date(epochSec * 1000);
    const day = d.getUTCDay(); // 0=Sun
    const daysToMon = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + daysToMon);
    mon.setUTCHours(0, 0, 0, 0);
    return Math.floor(mon.getTime() / 1000);
  }
  // Monthly: round down to 1st of month 00:00 UTC
  if (tf === "MN") {
    const d = new Date(epochSec * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }
  const slot = TF_MINUTES[tf] * 60;
  return Math.floor(epochSec / slot) * slot;
}

// ── Indicator maths ──────────────────────────────────────────────────────────
function computeEma(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  let ema: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (ema === null) {
      if (i >= period - 1) {
        ema = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
      }
    } else {
      ema = closes[i] * k + ema * (1 - k);
    }
    result[i] = ema;
  }
  return result;
}

function computeBollinger(closes: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const mid:   (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    mid[i]   = mean;
    upper[i] = mean + mult * std;
    lower[i] = mean - mult * std;
  }
  return { upper, mid, lower };
}

function normalizeBars(bars: RawCandleBar[]): CandlestickData[] {
  const byTime = new Map<number, CandlestickData>();
  for (const bar of bars) {
    byTime.set(bar.t, {
      time: bar.t as Time,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
    });
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

function resetViewport(chart: IChartApi | null, barCount = 0) {
  if (!chart) return;
  const visibleBars = Math.max(30, Math.min(barCount || 0, 180));
  if (barCount > 0) {
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(-2, barCount - visibleBars),
      to: barCount + 2,
    });
  } else {
    chart.timeScale().fitContent();
  }
  if (typeof window !== "undefined") {
    window.requestAnimationFrame(() => {
      if (barCount > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(-2, barCount - visibleBars),
          to: barCount + 2,
        });
      } else {
        chart.timeScale().fitContent();
      }
    });
  }
}

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
  forming,
  lastClose,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const slLineRef = useRef<IPriceLine | null>(null);
  const tpLineRef = useRef<IPriceLine | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const entryBandRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  // ── Indicator series refs ────────────────────────────────────────────────
  const ema9SeriesRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef  = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMidSeriesRef   = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const historyRef = useRef<CandlestickData[]>([]);
  const hasHistoryRef = useRef(false);
  const fetchSeqRef = useRef(0);
  const fitOnNextLoadRef = useRef(true);
  const lastFeedKeyRef = useRef("");

  const [activeTf, setActiveTf] = useState<TF>(() => {
    if (typeof window === "undefined") return "M5";
    const raw = localStorage.getItem("ifx_chart_tf");
    const stored = (raw as TF | null) ?? null;
    return stored && (TIMEFRAMES as readonly string[]).includes(stored) ? stored : "M5";
  });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [isLive, setIsLive] = useState(false);
  const [indicators, setIndicators] = useState<IndicatorConfig>(() => {
    if (typeof window === "undefined") return DEFAULT_INDICATORS;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_INDICATORS);
      if (!raw) return DEFAULT_INDICATORS;
      return { ...DEFAULT_INDICATORS, ...(JSON.parse(raw) as Partial<IndicatorConfig>) };
    } catch { return DEFAULT_INDICATORS; }
  });

  function toggleIndicator(key: keyof IndicatorConfig) {
    const next = { ...indicators, [key]: !indicators[key] };
    setIndicators(next);
    try { localStorage.setItem(STORAGE_KEY_INDICATORS, JSON.stringify(next)); } catch {}
  }

  const HISTORY_COUNT = Math.min(
    1500,
    Math.max(300, Number.parseInt(process.env.NEXT_PUBLIC_CHART_HISTORY_COUNT ?? "1200", 10) || 1200)
  );

  // Load a full set of bars into the chart (history fetch or TF switch).
  // Preserves the current forming bar if newer than the last fetched bar.
  const drawSeries = (bars: CandlestickData[], fit = false) => {
    const series = seriesRef.current;
    if (!series) return;

    // If we already have a live forming bar newer than the history, keep it.
    const prevLast = historyRef.current[historyRef.current.length - 1];
    const newLast  = bars[bars.length - 1];
    let merged = bars;
    if (prevLast && newLast && Number(prevLast.time) > Number(newLast.time)) {
      merged = [...bars, prevLast];
    }

    series.setData(merged);
    historyRef.current = merged;
    hasHistoryRef.current = merged.length > 0;
    setHistoryVersion(v => v + 1);
    if (fit) resetViewport(chartRef.current, merged.length);
  };

  // Incrementally update or append a single bar using series.update().
  // This avoids replacing the entire dataset and prevents flicker.
  const upsertLiveBar = (raw: RawCandleBar) => {
    const series = seriesRef.current;
    if (!series) return;

    const slot = toTfSlot(raw.t, activeTf);
    const next: CandlestickData = {
      time: slot as Time,
      open: raw.o,
      high: raw.h,
      low: raw.l,
      close: raw.c,
    };

    const current = historyRef.current;
    const last = current[current.length - 1];

    if (!last) {
      // No history yet — seed from this bar
      series.setData([next]);
      historyRef.current = [next];
      hasHistoryRef.current = true;
      resetViewport(chartRef.current, 1);
      return;
    }

    const lastT = Number(last.time);
    if (slot < lastT) return; // stale bar, ignore

    if (slot === lastT) {
      // Same candle — update in place (merge OHLC)
      const updated: CandlestickData = {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, next.high),
        low: Math.min(last.low, next.low),
        close: next.close,
      };
      series.update(updated);                          // incremental — no full redraw
      historyRef.current[current.length - 1] = updated;
      return;
    }

    // New candle — append
    series.update(next);                               // lightweight-charts appends automatically
    historyRef.current = [...current, next];
    setHistoryVersion(v => v + 1);
  };

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
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      priceFormat: priceFormat(liveSymbol ?? symbol),
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // ── Indicator series (all hidden by default; visibility toggled via applyOptions) ──
    ema9SeriesRef.current = chart.addSeries(LineSeries, {
      color: "#f97316", lineWidth: 1, lineStyle: LineStyle.Solid,
      visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    ema21SeriesRef.current = chart.addSeries(LineSeries, {
      color: "#a855f7", lineWidth: 1, lineStyle: LineStyle.Solid,
      visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbUpperSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(59,130,246,0.50)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbMidSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(59,130,246,0.75)", lineWidth: 1, lineStyle: LineStyle.Solid,
      visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    bbLowerSeriesRef.current = chart.addSeries(LineSeries, {
      color: "rgba(59,130,246,0.50)", lineWidth: 1, lineStyle: LineStyle.Dashed,
      visible: false, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    const ro = new ResizeObserver(() => {
      if (hasHistoryRef.current) resetViewport(chart, historyRef.current.length);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      slLineRef.current = null;
      tpLineRef.current = null;
      entryLineRef.current = null;
      entryBandRef.current = null;
      ema9SeriesRef.current = null;
      ema21SeriesRef.current = null;
      bbUpperSeriesRef.current = null;
      bbMidSeriesRef.current = null;
      bbLowerSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: priceFormat(liveSymbol ?? symbol) });
  }, [liveSymbol, symbol]);

  useEffect(() => {
    const feedKey = `${connId ?? ""}::${liveSymbol ?? symbol}`;
    if (feedKey === lastFeedKeyRef.current) return;

    lastFeedKeyRef.current = feedKey;
    seriesRef.current?.setData([]);
    historyRef.current = [];
    hasHistoryRef.current = false;
    fitOnNextLoadRef.current = true;
    setHistoryVersion((v) => v + 1);
  }, [connId, liveSymbol, symbol]);

  // Fetch history once on symbol/TF change. No periodic re-poll —
  // SSE (candle_update + candle_close) drives all live updates.
  useEffect(() => {
    if (!liveSymbol || !connId) return;
    if (!seriesRef.current) return;

    const ac = new AbortController();
    const seq = ++fetchSeqRef.current;
    const connQ = `&conn_id=${encodeURIComponent(connId)}`;
    const url = `/api/candles?symbol=${encodeURIComponent(liveSymbol)}&tf=${TF_API[activeTf]}&count=${HISTORY_COUNT}${connQ}`;

    const load = async () => {
      try {
        const resp = await fetch(url, { signal: ac.signal, cache: "no-store" });
        const data = (await resp.json()) as { bars?: RawCandleBar[] };
        if (ac.signal.aborted) return;
        if (seq !== fetchSeqRef.current) return;

        const normalized = normalizeBars(data.bars ?? []);
        if (!normalized.length) return;

        drawSeries(normalized, fitOnNextLoadRef.current);
        fitOnNextLoadRef.current = false;
        setIsLive(true);
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          console.warn("[CandlestickChart] load failed", err);
        }
      }
    };

    void load();
    return () => ac.abort();
  // fetchTick intentionally removed — no periodic re-poll needed with SSE
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSymbol, connId, activeTf, HISTORY_COUNT]);

  useEffect(() => {
    if (!liveSymbol || !forming) return;
    const current = forming[liveSymbol];
    if (!current) return;
    upsertLiveBar(current);
    setIsLive(true);
  }, [forming, liveSymbol, activeTf]);

  useEffect(() => {
    if (!liveSymbol || !lastClose) return;
    if (lastClose.symbol !== liveSymbol) return;
    upsertLiveBar(lastClose.bar);
    setIsLive(true);
  }, [lastClose, liveSymbol, activeTf]);

  // ── Draw / refresh indicators whenever candles or toggle state changes ──
  useEffect(() => {
    const candles = historyRef.current;
    const toLD = (vals: (number | null)[], times: Time[]): LineData[] =>
      vals.reduce<LineData[]>((arr, v, i) => {
        if (v !== null) arr.push({ time: times[i], value: v });
        return arr;
      }, []);

    const show = (ref: React.MutableRefObject<ISeriesApi<"Line"> | null>, data: LineData[]) => {
      ref.current?.setData(data);
      ref.current?.applyOptions({ visible: data.length > 0 });
    };
    const hide = (ref: React.MutableRefObject<ISeriesApi<"Line"> | null>) => {
      ref.current?.setData([]);
      ref.current?.applyOptions({ visible: false });
    };

    if (!candles.length) {
      hide(ema9SeriesRef); hide(ema21SeriesRef);
      hide(bbUpperSeriesRef); hide(bbMidSeriesRef); hide(bbLowerSeriesRef);
      return;
    }

    const closes = candles.map(c => c.close);
    const times  = candles.map(c => c.time);

    indicators.ema9  ? show(ema9SeriesRef,  toLD(computeEma(closes, 9),  times)) : hide(ema9SeriesRef);
    indicators.ema21 ? show(ema21SeriesRef, toLD(computeEma(closes, 21), times)) : hide(ema21SeriesRef);

    if (indicators.bb) {
      const { upper, mid, lower } = computeBollinger(closes, 20, 2);
      show(bbUpperSeriesRef, toLD(upper, times));
      show(bbMidSeriesRef,   toLD(mid,   times));
      show(bbLowerSeriesRef, toLD(lower, times));
    } else {
      hide(bbUpperSeriesRef); hide(bbMidSeriesRef); hide(bbLowerSeriesRef);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyVersion, indicators]);

  function switchTf(tf: TF) {
    seriesRef.current?.setData([]);
    historyRef.current = [];
    hasHistoryRef.current = false;
    setHistoryVersion(v => v + 1);
    fitOnNextLoadRef.current = true;
    setActiveTf(tf);
    try { localStorage.setItem("ifx_chart_tf", tf); } catch {}
  }

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (slLineRef.current) { s.removePriceLine(slLineRef.current); slLineRef.current = null; }
    if (sl && sl > 0) {
      slLineRef.current = s.createPriceLine({
        price: sl,
        color: COLORS.sl,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "SL",
      });
    }
  }, [sl]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (tpLineRef.current) { s.removePriceLine(tpLineRef.current); tpLineRef.current = null; }
    if (tp && tp > 0) {
      tpLineRef.current = s.createPriceLine({
        price: tp,
        color: COLORS.tp,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TP",
      });
    }
  }, [tp]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (entryLineRef.current) { s.removePriceLine(entryLineRef.current); entryLineRef.current = null; }
    if (entryPrice && entryPrice > 0) {
      entryLineRef.current = s.createPriceLine({
        price: entryPrice,
        color: COLORS.entry,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Entry",
      });
    }
  }, [entryPrice]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const low = typeof entryZoneLow === "number" && Number.isFinite(entryZoneLow) ? entryZoneLow : null;
    const high = typeof entryZoneHigh === "number" && Number.isFinite(entryZoneHigh) ? entryZoneHigh : null;

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
      entryBandRef.current.applyOptions({ baseValue: { type: "price", price: zoneLow } });
    }

    const band = entryBandRef.current;
    if (!band) return;

    const candles = historyRef.current;
    if (!candles.length) {
      band.setData([]);
      return;
    }

    band.setData(candles.map((c) => ({ time: c.time as Time, value: zoneHigh })));
  }, [entryZoneLow, entryZoneHigh, historyVersion]);

  const IND_CFG: Array<{ key: keyof IndicatorConfig; label: string; activeClass: string }> = [
    { key: "ema9",  label: "EMA9",  activeClass: "bg-orange-500/20 text-orange-300" },
    { key: "ema21", label: "EMA21", activeClass: "bg-purple-500/20 text-purple-300" },
    { key: "bb",    label: "BB20",  activeClass: "bg-blue-500/20 text-blue-300" },
  ];

  return (
    <div className={`flex flex-col ${className}`}>
      {/* ── Chart toolbar ── */}
      <div className="rounded-t-lg border border-[#2a2a2a] bg-[#0c0c0c]">
        {/* Row 1: symbol + timeframes */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono font-semibold text-sm text-white tracking-wide">
            {liveSymbol ?? symbol}
            {isLive ? (
              <span className="ml-2 text-xs font-normal text-emerald-500 animate-pulse">● LIVE</span>
            ) : liveSymbol ? (
              <span className="ml-2 text-xs font-normal text-yellow-500">⟳ loading…</span>
            ) : null}
          </span>
          <div className="flex flex-wrap gap-0.5 justify-end">
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
        {/* Row 2: indicator toggles */}
        <div className="flex items-center gap-1.5 border-t border-[#1e1e1e] px-3 py-1">
          <span className="text-[9px] uppercase tracking-widest text-gray-600 mr-0.5">Ind</span>
          {IND_CFG.map(({ key, label, activeClass }) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleIndicator(key)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                indicators[key]
                  ? activeClass
                  : "text-gray-600 hover:text-gray-300 hover:bg-[#1e1e1e]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="w-full border-x border-b border-[#2a2a2a] rounded-b-lg"
        style={{ height: "clamp(220px, 40vh, 420px)" }}
      />

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
