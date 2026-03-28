"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Wifi,
  WifiOff,
  CalendarDays,
  Clock,
  Filter,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NewsEvent = {
  id: string;
  currency: string;
  country: string;
  title: string;
  impact: "high" | "medium" | "low" | "unknown";
  scheduled_at_utc: string;
  category: string;
  provider: string;
};

type GroupedDate = {
  dateKey: string; // "2026-03-31"
  label: string;   // "Monday, March 31"
  isToday: boolean;
  events: NewsEvent[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"];

const CURRENCY_FLAGS: Record<string, string> = {
  USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵",
  AUD: "🇦🇺", CAD: "🇨🇦", CHF: "🇨🇭", NZD: "🇳🇿",
  CNY: "🇨🇳", SEK: "🇸🇪", NOK: "🇳🇴", MXN: "🇲🇽",
  HKD: "🇭🇰", SGD: "🇸🇬", ZAR: "🇿🇦",
};

const IMPACT_CONFIG = {
  high:    { label: "HIGH",   dot: "bg-red-500",    text: "text-red-400",    bar: "bg-red-500",    badge: "bg-red-500/15 text-red-400 border-red-500/30",    ring: "ring-red-500/40" },
  medium:  { label: "MED",    dot: "bg-amber-400",  text: "text-amber-400",  bar: "bg-amber-400",  badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",  ring: "ring-amber-400/40" },
  low:     { label: "LOW",    dot: "bg-yellow-600", text: "text-yellow-500", bar: "bg-yellow-500", badge: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",  ring: "" },
  unknown: { label: "—",      dot: "bg-gray-600",   text: "text-gray-500",   bar: "bg-gray-600",   badge: "bg-gray-700/40 text-gray-500 border-gray-600/20",   ring: "" },
};

const CATEGORY_COLORS: Record<string, string> = {
  central_bank: "text-violet-400",
  inflation:    "text-orange-400",
  labor:        "text-sky-400",
  growth:       "text-emerald-400",
  consumption:  "text-teal-400",
  macro:        "text-gray-400",
};

const PROVIDER_LABEL: Record<string, string> = {
  ecb:  "ECB", ons: "ONS", boj: "BOJ", snb: "SNB",
  rba:  "RBA", boc: "BOC", rbnz: "RBNZ", bls: "BLS", fred: "FRED",
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWeekBounds(refDate: Date): { start: Date; end: Date } {
  const d = new Date(refDate);
  const day = d.getUTCDay(); // 0=Sun
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7)); // Monday
  mon.setUTCHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  sun.setUTCHours(23, 59, 59, 999);
  return { start: mon, end: sun };
}

function fmtWeekLabel(start: Date, end: Date) {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = start.toLocaleDateString(undefined, opts);
  const e = end.toLocaleDateString(undefined, { ...opts, year: "numeric" });
  return `${s} – ${e}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const isToday =
    d.getUTCFullYear() === today.getUTCFullYear() &&
    d.getUTCMonth() === today.getUTCMonth() &&
    d.getUTCDate() === today.getUTCDate();
  return {
    label: d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    isToday,
  };
}

function groupByDate(events: NewsEvent[]): GroupedDate[] {
  const map = new Map<string, NewsEvent[]>();
  for (const ev of events) {
    const key = ev.scheduled_at_utc.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, evs]) => {
      const { label, isToday } = fmtDayLabel(evs[0].scheduled_at_utc);
      return { dateKey: key, label, isToday, events: evs.sort((a, b) => a.scheduled_at_utc.localeCompare(b.scheduled_at_utc)) };
    });
}

function fmtCountdown(iso: string, now: Date): { label: string; urgent: boolean; past: boolean } {
  const diff = new Date(iso).getTime() - now.getTime();
  const absMs = Math.abs(diff);
  const past = diff < 0;
  const mins = Math.floor(absMs / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let label: string;
  if (mins < 1) label = "Now";
  else if (mins < 60) label = `${mins}m`;
  else if (hrs < 24) label = `${hrs}h ${mins % 60}m`;
  else label = `${days}d`;
  return { label, urgent: !past && mins <= 30, past };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ImpactBars({ impact }: { impact: NewsEvent["impact"] }) {
  const bars = impact === "high" ? 3 : impact === "medium" ? 2 : 1;
  const cfg = IMPACT_CONFIG[impact];
  return (
    <div className="flex items-end gap-[3px]">
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className={`w-[4px] rounded-sm transition-all ${n <= bars ? cfg.bar : "bg-[#2a2a2a]"}`}
          style={{ height: n === 1 ? 8 : n === 2 ? 12 : 16 }}
        />
      ))}
    </div>
  );
}

function CountdownBadge({ iso, now }: { iso: string; now: Date }) {
  const { label, urgent, past } = fmtCountdown(iso, now);
  if (past) return <span className="text-[11px] text-gray-600">{label} ago</span>;
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
        urgent ? "animate-pulse bg-red-500/20 text-red-300" : "bg-[#1a1a1a] text-gray-400"
      }`}
    >
      {label}
    </span>
  );
}

function NowLine() {
  return (
    <tr>
      <td colSpan={7}>
        <div className="relative flex items-center gap-2 py-1 px-4">
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-orange-500 to-transparent opacity-60" />
          <span className="px-2 py-0.5 rounded text-[11px] font-bold text-orange-400 bg-orange-500/10 border border-orange-500/20 tracking-widest">
            ▶ NOW
          </span>
          <div className="flex-1 h-px bg-gradient-to-r from-transparent via-orange-500 to-transparent opacity-60" />
        </div>
      </td>
    </tr>
  );
}

function StatsBar({ events }: { events: NewsEvent[] }) {
  const high = events.filter((e) => e.impact === "high").length;
  const med = events.filter((e) => e.impact === "medium").length;
  const low = events.filter((e) => e.impact === "low").length;
  const byCcy = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.currency] = (acc[e.currency] ?? 0) + 1;
    return acc;
  }, {});
  const topCcy = Object.entries(byCcy).sort(([, a], [, b]) => b - a).slice(0, 5);

  return (
    <div className="flex flex-wrap items-center gap-4 text-[12px]">
      <span className="text-gray-500">{events.length} events</span>
      {high > 0 && <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-red-500 inline-block" /><span className="text-red-400 font-semibold">{high} High</span></span>}
      {med > 0 && <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-amber-400 inline-block" /><span className="text-amber-400">{med} Med</span></span>}
      {low > 0 && <span className="text-gray-500">{low} Low</span>}
      <span className="hidden sm:flex items-center gap-1 text-gray-600">
        {topCcy.map(([ccy, cnt]) => (
          <span key={ccy} className="text-gray-400">{CURRENCY_FLAGS[ccy] ?? "🌐"} <span className="text-gray-500">{cnt}</span></span>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CalendarPage
// ---------------------------------------------------------------------------

export function CalendarPage() {
  const nowRef = useRef(new Date());
  const [tick, setTick] = useState(0); // for countdown updates
  const [weekRef, setWeekRef] = useState(new Date());
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"ok" | "no_table" | "error" | "idle">("idle");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filters
  const [impactFilter, setImpactFilter] = useState<Set<string>>(new Set(["high", "medium", "low"]));
  const [currencyFilter, setCurrencyFilter] = useState<Set<string>>(new Set());

  const { start: weekStart, end: weekEnd } = getWeekBounds(weekRef);

  // Countdown ticker — every second
  useEffect(() => {
    const t = setInterval(() => {
      nowRef.current = new Date();
      setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const fetchEvents = useCallback(async (showRefreshIndicator = false) => {
    if (showRefreshIndicator) setIsRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
        impacts: "all",
      });
      const res = await fetch(`/api/news/upcoming?${params}`);
      if (!res.ok) { setStatus("error"); return; }
      const json = await res.json() as { events: NewsEvent[]; status?: string };
      setEvents(json.events ?? []);
      setStatus((json.status as "ok" | "no_table" | "error") ?? "ok");
      setLastRefresh(new Date());
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [weekStart, weekEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on week change
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const t = setInterval(() => fetchEvents(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchEvents]);

  // Filtered view
  const filteredEvents = events.filter((ev) => {
    if (!impactFilter.has(ev.impact)) return false;
    if (currencyFilter.size > 0 && !currencyFilter.has(ev.currency)) return false;
    return true;
  });

  const grouped = groupByDate(filteredEvents);
  const now = nowRef.current;

  function toggleImpact(val: string) {
    setImpactFilter((prev) => {
      const next = new Set(prev);
      next.has(val) ? next.delete(val) : next.add(val);
      return next;
    });
  }

  function toggleCurrency(val: string) {
    setCurrencyFilter((prev) => {
      const next = new Set(prev);
      next.has(val) ? next.delete(val) : next.add(val);
      return next;
    });
  }

  const isCurrentWeek = (() => {
    const { start } = getWeekBounds(new Date());
    return weekStart.toISOString().slice(0, 10) === start.toISOString().slice(0, 10);
  })();

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="-m-4 lg:-m-6 min-h-full bg-[#080808] text-white font-sans overflow-x-hidden">

      {/* ── Page header ── */}
      <div className="border-b border-[#1a1a1a] bg-[#0c0c0c] px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-blue-600 shadow-lg shadow-violet-900/30">
              <CalendarDays className="size-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-none">Economic Calendar</h1>
              <p className="mt-0.5 text-[11px] text-gray-500">
                ECB · ONS · BOJ · SNB · RBA · BOC · RBNZ · BLS
                {lastRefresh && <span className="ml-2 text-gray-600">· Updated {lastRefresh.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatsBar events={filteredEvents} />
            <button
              onClick={() => fetchEvents(true)}
              disabled={isRefreshing}
              className="ml-2 flex items-center gap-1.5 rounded-lg border border-[#222] bg-[#111] px-3 py-1.5 text-[12px] text-gray-400 hover:text-white hover:border-[#333] transition-all disabled:opacity-40"
            >
              <RefreshCw className={`size-3 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
            {status === "ok" ? (
              <span className="flex items-center gap-1 text-[11px] text-emerald-500"><Wifi className="size-3" /> Live</span>
            ) : status === "error" ? (
              <span className="flex items-center gap-1 text-[11px] text-red-500"><WifiOff className="size-3" /> Error</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="sticky top-0 z-20 border-b border-[#1a1a1a] bg-[#0c0c0c]/95 backdrop-blur-sm px-4 py-3 lg:px-6">
        <div className="flex flex-wrap items-center gap-3">

          {/* Week navigation */}
          <div className="flex items-center gap-1 rounded-lg border border-[#222] bg-[#111] p-1">
            <button
              onClick={() => setWeekRef((d) => { const nd = new Date(d); nd.setUTCDate(nd.getUTCDate() - 7); return nd; })}
              className="rounded p-1 text-gray-500 hover:text-white hover:bg-[#1a1a1a] transition-colors"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="px-2 text-[13px] font-medium text-gray-300 whitespace-nowrap">
              {fmtWeekLabel(weekStart, weekEnd)}
            </span>
            <button
              onClick={() => setWeekRef((d) => { const nd = new Date(d); nd.setUTCDate(nd.getUTCDate() + 7); return nd; })}
              className="rounded p-1 text-gray-500 hover:text-white hover:bg-[#1a1a1a] transition-colors"
            >
              <ChevronRight className="size-4" />
            </button>
            {!isCurrentWeek && (
              <button
                onClick={() => setWeekRef(new Date())}
                className="ml-1 rounded px-2 py-0.5 text-[11px] font-semibold text-violet-400 hover:bg-violet-500/10 transition-colors"
              >
                Today
              </button>
            )}
          </div>

          {/* Impact toggles */}
          <div className="flex items-center gap-1 rounded-lg border border-[#222] bg-[#111] p-1">
            <Filter className="ml-1 size-3 text-gray-600" />
            {(["high", "medium", "low"] as const).map((imp) => {
              const cfg = IMPACT_CONFIG[imp];
              const active = impactFilter.has(imp);
              return (
                <button
                  key={imp}
                  onClick={() => toggleImpact(imp)}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] font-semibold transition-all ${
                    active ? cfg.badge + " border" : "text-gray-600 hover:text-gray-400"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${active ? cfg.dot : "bg-gray-700"}`} />
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {/* Currency filters */}
          <div className="flex flex-wrap items-center gap-1">
            {CURRENCIES.map((ccy) => {
              const active = currencyFilter.has(ccy);
              return (
                <button
                  key={ccy}
                  onClick={() => toggleCurrency(ccy)}
                  className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-all ${
                    active
                      ? "border-violet-500/50 bg-violet-500/10 text-violet-300"
                      : "border-[#222] bg-[#111] text-gray-500 hover:text-gray-300 hover:border-[#333]"
                  }`}
                >
                  <span>{CURRENCY_FLAGS[ccy] ?? "🌐"}</span>
                  <span>{ccy}</span>
                </button>
              );
            })}
            {currencyFilter.size > 0 && (
              <button
                onClick={() => setCurrencyFilter(new Set())}
                className="rounded-full border border-[#1a1a1a] px-2 py-1 text-[11px] text-gray-600 hover:text-white hover:border-[#333] transition-all"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── No table notice ── */}
      {status === "no_table" && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-[13px]">
          <p className="font-semibold text-amber-400">Database table not found</p>
          <p className="mt-1 text-gray-400">
            Run <code className="rounded bg-[#111] px-1.5 py-0.5 text-amber-300">docs/economic_events_migration.sql</code> in Supabase, then{" "}
            <code className="rounded bg-[#111] px-1.5 py-0.5 text-amber-300">python runtime/news_refresh.py</code> on the Windows server.
          </p>
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="space-y-2 p-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-[#111] animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && filteredEvents.length === 0 && status === "ok" && (
        <div className="flex flex-col items-center justify-center py-24 gap-3 text-gray-600">
          <CalendarDays className="size-10 opacity-30" />
          <p className="text-sm">No events found for this week with current filters.</p>
          <p className="text-[12px]">Run <code className="text-gray-500">python runtime/news_refresh.py</code> to populate data.</p>
        </div>
      )}

      {/* ── Calendar table ── */}
      {!loading && grouped.length > 0 && (
        <div className="px-4 pt-4 pb-10 lg:px-6">
          <table className="w-full text-[13px] border-separate border-spacing-0">

            {/* Table header */}
            <thead>
              <tr className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600">
                <th className="w-[72px] pb-2 text-left pl-2">Time</th>
                <th className="w-[80px] pb-2 text-left">Currency</th>
                <th className="w-[52px] pb-2 text-center">Impact</th>
                <th className="pb-2 text-left pl-3">Event</th>
                <th className="w-[80px] pb-2 text-right pr-3 hidden sm:table-cell">Actual</th>
                <th className="w-[80px] pb-2 text-right pr-3 hidden md:table-cell">Forecast</th>
                <th className="w-[80px] pb-2 text-right pr-3 hidden md:table-cell">Previous</th>
                <th className="w-[72px] pb-2 text-right pr-2 hidden sm:table-cell">
                  <Clock className="size-3 inline mb-0.5" />
                </th>
              </tr>
            </thead>

            <tbody>
              {grouped.map((group) => {
                const rows: React.ReactNode[] = [];
                let nowLineInserted = false;

                // Date header row
                rows.push(
                  <tr key={`hdr-${group.dateKey}`}>
                    <td colSpan={8} className="pt-5 pb-2 pl-2">
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-[13px] font-bold tracking-wide ${
                            group.isToday ? "text-violet-300" : "text-gray-300"
                          }`}
                        >
                          {group.label}
                        </span>
                        {group.isToday && (
                          <span className="rounded-full bg-violet-500/20 border border-violet-500/30 px-2 py-0.5 text-[10px] font-bold text-violet-400 tracking-widest">
                            TODAY
                          </span>
                        )}
                        {group.events.filter((e) => e.impact === "high").length > 0 && (
                          <span className="text-[11px] text-red-500">
                            {group.events.filter((e) => e.impact === "high").length} high-impact
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );

                // Event rows
                group.events.forEach((ev, idx) => {
                  const evTime = new Date(ev.scheduled_at_utc);
                  const isPast = evTime < now;
                  const cfg = IMPACT_CONFIG[ev.impact] ?? IMPACT_CONFIG.unknown;
                  const catColor = CATEGORY_COLORS[ev.category] ?? "text-gray-500";

                  // Insert NOW line before first future event on today
                  if (group.isToday && !nowLineInserted && !isPast) {
                    nowLineInserted = true;
                    rows.push(<NowLine key={`now-${group.dateKey}-${idx}`} />);
                  }

                  rows.push(
                    <tr
                      key={ev.id}
                      className={`group/row transition-colors ${
                        isPast ? "opacity-45" : ""
                      } hover:bg-white/[0.025] border-b border-[#111]`}
                    >
                      {/* Time */}
                      <td className="py-3 pl-2 pr-2 align-middle">
                        <span className={`tabular-nums font-mono text-[12px] ${isPast ? "text-gray-600" : "text-gray-300"}`}>
                          {fmtTime(ev.scheduled_at_utc)}
                        </span>
                      </td>

                      {/* Currency */}
                      <td className="py-3 pr-2 align-middle">
                        <div className="flex items-center gap-1.5">
                          <span className="text-base leading-none">{CURRENCY_FLAGS[ev.currency] ?? "🌐"}</span>
                          <span className="font-bold text-[12px] text-gray-200">{ev.currency}</span>
                        </div>
                      </td>

                      {/* Impact bars */}
                      <td className="py-3 pr-2 align-middle">
                        <div className="flex items-center justify-center">
                          <div className={`rounded p-1 ${ev.impact === "high" ? "bg-red-500/10" : ev.impact === "medium" ? "bg-amber-500/10" : "bg-[#1a1a1a]"}`}>
                            <ImpactBars impact={ev.impact} />
                          </div>
                        </div>
                      </td>

                      {/* Event title + category */}
                      <td className="py-3 pl-3 pr-2 align-middle max-w-0">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className={`font-semibold truncate ${isPast ? "text-gray-500" : ev.impact === "high" ? "text-white" : "text-gray-200"}`}>
                            {ev.title}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] uppercase tracking-wide font-medium ${catColor}`}>
                              {ev.category?.replace(/_/g, " ")}
                            </span>
                            <span className="text-[10px] text-gray-700 uppercase">
                              {PROVIDER_LABEL[ev.provider] ?? ev.provider}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Actual */}
                      <td className="py-3 pr-3 text-right align-middle hidden sm:table-cell">
                        <span className="text-gray-700 text-[12px]">—</span>
                      </td>

                      {/* Forecast */}
                      <td className="py-3 pr-3 text-right align-middle hidden md:table-cell">
                        <span className="text-gray-700 text-[12px]">—</span>
                      </td>

                      {/* Previous */}
                      <td className="py-3 pr-3 text-right align-middle hidden md:table-cell">
                        <span className="text-gray-700 text-[12px]">—</span>
                      </td>

                      {/* Countdown */}
                      <td className="py-3 pr-2 text-right align-middle hidden sm:table-cell">
                        {!isPast ? (
                          <CountdownBadge iso={ev.scheduled_at_utc} now={now} />
                        ) : (
                          <span className="text-[11px] text-gray-700">Done</span>
                        )}
                      </td>
                    </tr>
                  );
                });

                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Bottom info bar ── */}
      <div className="sticky bottom-0 border-t border-[#1a1a1a] bg-[#0c0c0c]/90 backdrop-blur-sm px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-600">
          <span>Auto-refreshes every 5 min · Populate with <code className="text-gray-500">python runtime/news_refresh.py</code></span>
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {tick > -1 && now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
      </div>
    </div>
  );
}
