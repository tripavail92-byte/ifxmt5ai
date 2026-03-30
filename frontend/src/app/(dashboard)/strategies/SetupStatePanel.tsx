"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/utils/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

type SetupState = "IDLE" | "STALKING" | "PURGATORY" | "DEAD";

interface TradingSetup {
  id: string;
  symbol: string;
  side: string;
  entry_price: number;
  zone_percent: number;
  timeframe?: string;
  zone_low: number;
  zone_high: number;
  loss_edge: number;
  target: number;
  state: SetupState;
  dead_trigger_candle_time: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ─── State badge config ───────────────────────────────────────────────────────

const STATE_CFG: Record<SetupState, {
  badge: string;
  dot: string;
  cardBorder: string;
  label: string;
  desc: string;
}> = {
  IDLE: {
    badge:      "bg-gray-500/15 text-gray-400 border-gray-500/30",
    dot:        "bg-gray-500",
    cardBorder: "border-[#1e1e1e]",
    label:      "IDLE",
    desc:       "Waiting — price away from zone",
  },
  STALKING: {
    badge:      "bg-blue-500/15 text-blue-400 border-blue-500/30",
    dot:        "bg-blue-400 animate-pulse",
    cardBorder: "border-blue-500/20",
    label:      "STALKING",
    desc:       "Price in zone — watching closely",
  },
  PURGATORY: {
    badge:      "bg-amber-500/15 text-amber-400 border-amber-500/30",
    dot:        "bg-amber-400 animate-pulse",
    cardBorder: "border-amber-500/20",
    label:      "PURGATORY",
    desc:       "Wick broke loss edge — awaiting H1 close",
  },
  DEAD: {
    badge:      "bg-red-500/15 text-red-400 border-red-500/30",
    dot:        "bg-red-500",
    cardBorder: "border-red-500/15",
    label:      "DEAD",
    desc:       "H1 closed beyond loss edge — invalidated",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number, sym: string): string {
  return v.toFixed(/JPY|XAU|XAG/i.test(sym) ? 3 : /BTC|ETH|OIL/i.test(sym) ? 2 : 5);
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SetupStatePanel({ connectionId }: { connectionId: string }) {
  const [setups, setSetups]   = useState<TradingSetup[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow]         = useState(0);  // 0 on server — set after mount
  // Prevent SSR — avoids React hydration mismatch (#418)
  // createBrowserClient must NOT be called during server rendering
  const [mounted, setMounted] = useState(false);

  // Lazy-initialised after mount — never called on server
  const supabase = useRef<SupabaseClient | null>(null);

  // Create the Supabase client lazily after mount — never runs on server
  useEffect(() => {
    supabase.current = createClient();
    setMounted(true);
    setNow(Date.now());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initial load (runs only after mount so supabase.current is set) ────────
  useEffect(() => {
    if (!mounted) return;
    const sb = supabase.current!;
    let cancelled = false;
    sb.rpc("get_setups_for_connection", { p_connection_id: connectionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setSetups(data as TradingSetup[]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [mounted, connectionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime subscription ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    const sb = supabase.current!;
    const channel = sb
      .channel(`setups-${connectionId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event:  "*",
          schema: "public",
          table:  "trading_setups",
          filter: `connection_id=eq.${connectionId}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const row = payload.new as TradingSetup;

          if (payload.eventType === "INSERT") {
            if (row.is_active) setSetups(prev => [row, ...prev]);

          } else if (payload.eventType === "UPDATE") {
            setSetups(prev =>
              row.is_active
                ? prev.some(s => s.id === row.id)
                  ? prev.map(s => s.id === row.id ? row : s)
                  : [row, ...prev]
                : prev.filter(s => s.id !== row.id)
            );

          } else if (payload.eventType === "DELETE") {
            const old = payload.old as TradingSetup;
            setSetups(prev => prev.filter(s => s.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [mounted, connectionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tick "time ago" every 30s ─────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [mounted]);

  // ── Render ────────────────────────────────────────────────────────────────

  // Don't render anything server-side or before hydration — avoids #418
  if (!mounted) return null;

  if (loading) {
    return (
      <div className="rounded-xl border border-[#1e1e1e] bg-[#0a0a0a] px-4 py-3 space-y-2">
        {[1, 2].map(i => (
          <div key={i} className="h-14 bg-[#141414] rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (setups.length === 0) return null;

  return (
    <div className="rounded-xl border border-[#1e1e1e] bg-[#0a0a0a] overflow-hidden shadow-2xl">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#111] border-b border-[#1e1e1e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-widest">
            Active Setups
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20 font-bold">
            {setups.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-gray-500">REALTIME</span>
        </div>
      </div>

      {/* Setup cards */}
      <div className="divide-y divide-[#141414]">
        {setups.map(setup => {
          const cfg    = STATE_CFG[setup.state] ?? STATE_CFG.IDLE;
          const isLong = setup.side === "buy";
          const updatedAgo = timeAgo(setup.updated_at);
          void now; // consumed to re-render

          return (
            <div
              key={setup.id}
              className={`px-4 py-3 border-l-2 transition-all duration-500 ${cfg.cardBorder}`}
            >
              {/* Top row: symbol + side + state badge */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono font-bold text-sm text-white truncate">
                    {setup.symbol}
                  </span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0
                    ${isLong
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-red-500/15 text-red-400"
                    }`}>
                    {isLong ? "▲ BUY" : "▼ SELL"}
                  </span>
                </div>

                {/* State badge */}
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold tracking-widest shrink-0 ${cfg.badge}`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} />
                  {cfg.label}
                </div>
              </div>

              {/* Description */}
              <p className="text-[10px] text-gray-600 mt-0.5">{cfg.desc}</p>

              {/* Zone level grid */}
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                <div className="bg-[#141414] rounded p-1.5 text-center">
                  <div className="text-[9px] text-gray-600 uppercase mb-0.5">Entry</div>
                  <div className="text-[10px] font-mono font-semibold text-gray-300">
                    {fmt(setup.entry_price, setup.symbol)}
                  </div>
                </div>
                <div className="bg-[#141414] rounded p-1.5 text-center">
                  <div className="text-[9px] text-gray-600 uppercase mb-0.5">Zone</div>
                  <div className="text-[10px] font-mono text-blue-400 leading-tight">
                    {fmt(setup.zone_low, setup.symbol)}<br/>
                    <span className="text-gray-600">–</span><br/>
                    {fmt(setup.zone_high, setup.symbol)}
                  </div>
                </div>
                <div className="bg-[#141414] rounded p-1.5 text-center">
                  <div className="text-[9px] text-gray-600 uppercase mb-0.5">Loss Edge</div>
                  <div className="text-[10px] font-mono font-semibold text-red-400">
                    {fmt(setup.loss_edge, setup.symbol)}
                  </div>
                </div>
                <div className="bg-[#141414] rounded p-1.5 text-center">
                  <div className="text-[9px] text-gray-600 uppercase mb-0.5">Target</div>
                  <div className="text-[10px] font-mono font-semibold text-emerald-400">
                    {fmt(setup.target, setup.symbol)}
                  </div>
                </div>
              </div>

              {/* Footer: last updated */}
              <div className="mt-1.5 text-[9px] text-gray-700 text-right">
                updated {updatedAgo}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
