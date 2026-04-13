"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

type HudStatus =
  | "ASLEEP"
  | "STALKING"
  | "PURGATORY"
  | "IN_TRADE"
  | "BLEEDING"
  | "MAX_TRADES"
  | "DEAD"
  | "UNPAIRED"
  | "CONFIG_LOADING"
  | "ERROR"
  | string;

interface LedgerEntry {
  ticket:     number;
  symbol:     string;
  side:       string;
  entry:      number;
  exit:       number;
  pnl:        number;
  close_time: string;
}

interface EaLiveState {
  connection_id:    string;
  hud_status:       HudStatus;
  sys_bias:         string | null;
  sys_pivot:        number | null;
  sys_tp1:          number | null;
  sys_tp2:          number | null;
  invalidation_lvl: number | null;
  live_sl:          number | null;
  live_lots:        number | null;
  is_inside_zone:   boolean;
  is_be_secured:    boolean;
  unrealised_pnl:   number | null;
  daily_trades_count: number;
  daily_pnl_usd:    number;
  top_ledger:       LedgerEntry[];
  updated_at:       string;
}

interface TradeAuditRow {
  id:              string;
  symbol:          string;
  side:            string;
  entry:           number | null;
  sl:              number | null;
  tp:              number | null;
  volume:          number | null;
  broker_ticket:   string | null;
  status:          string;
  decision_reason: string | null;
  payload:         Record<string, unknown>;
  created_at:      string;
}

// ─── HUD status config ────────────────────────────────────────────────────────

const HUD_CFG: Record<string, { dot: string; badge: string; label: string }> = {
  ASLEEP: {
    dot:   "bg-gray-500",
    badge: "bg-gray-500/15 text-gray-400 border-gray-500/30",
    label: "ASLEEP",
  },
  UNPAIRED: {
    dot:   "bg-gray-600",
    badge: "bg-gray-500/15 text-gray-500 border-gray-500/20",
    label: "UNPAIRED",
  },
  CONFIG_LOADING: {
    dot:   "bg-amber-400 animate-pulse",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    label: "LOADING",
  },
  STALKING: {
    dot:   "bg-blue-400 animate-pulse",
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    label: "STALKING",
  },
  PURGATORY: {
    dot:   "bg-amber-400 animate-pulse",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    label: "PURGATORY",
  },
  IN_TRADE: {
    dot:   "bg-emerald-400 animate-pulse",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    label: "IN TRADE",
  },
  BLEEDING: {
    dot:   "bg-red-400 animate-pulse",
    badge: "bg-red-500/20 text-red-400 border-red-500/40",
    label: "BLEEDING",
  },
  MAX_TRADES: {
    dot:   "bg-orange-400",
    badge: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    label: "MAX TRADES",
  },
  DEAD: {
    dot:   "bg-red-600",
    badge: "bg-red-900/40 text-red-400 border-red-700/40",
    label: "DEAD",
  },
  ERROR: {
    dot:   "bg-red-500",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
    label: "ERROR",
  },
};

function hudCfg(status: HudStatus) {
  return HUD_CFG[status] ?? {
    dot:   "bg-gray-500",
    badge: "bg-gray-500/15 text-gray-400 border-gray-500/20",
    label: status,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 5): string {
  if (v == null) return "—";
  return v.toFixed(decimals);
}

function fmtLevels(v: number | null | undefined, symbol?: string | null): string {
  if (v == null) return "—";
  if (!symbol) return v.toFixed(5);
  if (/XAU|XAG/i.test(symbol)) return v.toFixed(2);
  if (/JPY/i.test(symbol))     return v.toFixed(3);
  if (/BTC|ETH/i.test(symbol)) return v.toFixed(1);
  if (/OIL|USD/i.test(symbol)) return v.toFixed(2);
  return v.toFixed(5);
}

function pnlClass(pnl: number | null | undefined): string {
  if (pnl == null) return "text-gray-500";
  return pnl >= 0 ? "text-emerald-400" : "text-red-400";
}

function fmtPnl(pnl: number | null | undefined): string {
  if (pnl == null) return "—";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 5)    return "just now";
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function biasColor(bias: string | null): string {
  if (!bias) return "text-gray-500";
  const b = bias.toLowerCase();
  if (b === "buy" || b === "long")    return "text-emerald-400";
  if (b === "sell" || b === "short")  return "text-red-400";
  return "text-gray-400";
}

// ─── Null/no-data placeholder ─────────────────────────────────────────────────

function NoDataCard() {
  return (
    <div className="rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-gray-700" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-gray-600">EA Live HUD</span>
      </div>
      <div className="text-center py-6 text-gray-700 text-xs">
        EA not yet connected — no live state received
      </div>
    </div>
  );
}

// ─── Trade Audit Log ──────────────────────────────────────────────────────────

function TradeAuditLog({ connectionId }: { connectionId: string }) {
  const [rows,       setRows]       = useState<TradeAuditRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded,   setExpanded]   = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const url = `/api/ea/trade-audit?connection_id=${connectionId}&limit=20${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json() as { rows: TradeAuditRow[]; next_cursor: string | null };
      setRows(prev => cursor ? [...prev, ...json.rows] : json.rows);
      setNextCursor(json.next_cursor);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { load(); }, [load]);

  const sideColor = (side: string) => {
    const s = side.toLowerCase();
    if (s.includes("buy") && !s.includes("close")) return "text-emerald-400";
    if (s.includes("sell") && !s.includes("close")) return "text-red-400";
    return "text-gray-500";
  };

  const statusBadge = (status: string) => {
    if (status === "open")   return "text-blue-400 border-blue-500/30 bg-blue-500/10";
    if (status === "closed") return "text-gray-400 border-gray-600/30 bg-gray-700/10";
    if (status === "failed") return "text-red-400 border-red-500/30 bg-red-500/10";
    return "text-gray-600 border-gray-700/20 bg-transparent";
  };

  const pnlFromPayload = (row: TradeAuditRow) => {
    const pnl = typeof row.payload?.pnl === "number" ? row.payload.pnl : null;
    if (pnl == null) return null;
    return { value: pnl, cls: pnl >= 0 ? "text-emerald-400" : "text-red-400" };
  };

  return (
    <div className="border-t border-[#1a1a1a] pt-3">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center justify-between w-full text-left mb-2"
      >
        <span className="text-[9px] text-gray-600 uppercase tracking-widest">Trade Audit</span>
        <span className="text-[9px] text-gray-700 font-mono">{expanded ? "▲ hide" : "▼ show"}</span>
      </button>

      {expanded && (
        <div className="space-y-1">
          {loading && (
            <div className="text-[10px] text-gray-700 font-mono">loading…</div>
          )}
          {!loading && rows.length === 0 && (
            <div className="text-[10px] text-gray-700 font-mono">No trades recorded yet</div>
          )}
          {rows.map(row => {
            const pnl = pnlFromPayload(row);
            return (
              <div key={row.id} className="grid grid-cols-[70px_55px_55px_50px_1fr_60px] gap-x-1.5 items-center text-[10px] font-mono border-b border-[#131313] pb-1 last:border-0">
                <span className="text-gray-400 truncate">{row.symbol}</span>
                <span className={sideColor(row.side)}>{row.side.replace("_close", "↩").toUpperCase()}</span>
                <span className="text-gray-500">{row.entry != null ? fmtLevels(row.entry, row.symbol) : "—"}</span>
                <span className={`text-[9px] px-1 py-0.5 rounded border font-semibold ${statusBadge(row.status)}`}>{row.status}</span>
                <span className="text-gray-700 truncate text-[9px]">{row.broker_ticket ?? "—"}</span>
                {pnl != null
                  ? <span className={`text-right font-semibold ${pnl.cls}`}>{pnl.value >= 0 ? "+" : ""}${pnl.value.toFixed(2)}</span>
                  : <span className="text-gray-700 text-right">—</span>
                }
              </div>
            );
          })}
          {nextCursor && (
            <button
              onClick={() => load(nextCursor)}
              disabled={loading}
              className="text-[9px] text-gray-600 hover:text-gray-400 disabled:opacity-40 font-mono pt-1"
            >
              {loading ? "loading…" : "load more ↓"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EaLivePanel({ connectionId }: { connectionId: string }) {
  const [state,   setState]   = useState<EaLiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [now,     setNow]     = useState(0);
  const [mounted, setMounted] = useState(false);

  const supabase = useRef<SupabaseClient | null>(null);

  // Boot client after mount only (no SSR)
  useEffect(() => {
    supabase.current = createClient();
    setMounted(true);
    setNow(Date.now());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initial fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    const sb = supabase.current!;
    let cancelled = false;

    sb.from("ea_live_state")
      .select("*")
      .eq("connection_id", connectionId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (!error && data) setState(data as EaLiveState);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [mounted, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Realtime subscription (UPDATE only — PK-filtered table) ───────────────
  useEffect(() => {
    if (!mounted) return;
    const sb = supabase.current!;

    const channel = sb
      .channel(`ea-live-${connectionId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event:  "*",
          schema: "public",
          table:  "ea_live_state",
          filter: `connection_id=eq.${connectionId}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          if (payload.eventType === "DELETE") {
            setState(null);
          } else {
            setState(payload.new as EaLiveState);
          }
          setNow(Date.now());
        },
      )
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, [mounted, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tick "time ago" every 10s ─────────────────────────────────────────────
  useEffect(() => {
    if (!mounted) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted || loading) {
    return (
      <div className="rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] p-4 animate-pulse">
        <div className="h-4 w-28 bg-[#1a1a1a] rounded mb-3" />
        <div className="h-16 bg-[#1a1a1a] rounded" />
      </div>
    );
  }

  if (!state) return <NoDataCard />;

  const cfg      = hudCfg(state.hud_status);
  const inTrade  = state.hud_status === "IN_TRADE" || state.hud_status === "BLEEDING";
  const ledger   = Array.isArray(state.top_ledger) ? state.top_ledger : [];
  const updatedAgo = now ? timeAgo(state.updated_at) : "";

  // Symbol hint from ledger for level formatting
  const symbol = ledger[0]?.symbol ?? null;

  return (
    <div className="rounded-xl border border-[#1e1e1e] bg-[#0b0b0b] p-4 space-y-4">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
          <span className="text-[10px] font-mono uppercase tracking-widest text-gray-500">EA Live HUD</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 rounded border ${cfg.badge}`}>
            {cfg.label}
          </span>
          {now > 0 && (
            <span className="text-[9px] text-gray-700 font-mono">{updatedAgo}</span>
          )}
        </div>
      </div>

      {/* ── Bias + Levels ────────────────────────────────────────────── */}
      <div className="grid grid-cols-5 gap-1.5">
        <div className="bg-[#111] rounded p-2 text-center">
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Bias</div>
          <div className={`text-[11px] font-mono font-bold uppercase ${biasColor(state.sys_bias)}`}>
            {state.sys_bias ?? "—"}
          </div>
        </div>
        <div className="bg-[#111] rounded p-2 text-center">
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Pivot</div>
          <div className="text-[10px] font-mono text-gray-300">
            {fmtLevels(state.sys_pivot, symbol)}
          </div>
        </div>
        <div className="bg-[#111] rounded p-2 text-center">
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">TP1</div>
          <div className="text-[10px] font-mono text-cyan-400">
            {fmtLevels(state.sys_tp1, symbol)}
          </div>
        </div>
        <div className="bg-[#111] rounded p-2 text-center">
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">TP2</div>
          <div className="text-[10px] font-mono text-sky-400">
            {fmtLevels(state.sys_tp2, symbol)}
          </div>
        </div>
        <div className="bg-[#111] rounded p-2 text-center">
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Inval</div>
          <div className="text-[10px] font-mono text-red-400/80">
            {fmtLevels(state.invalidation_lvl, symbol)}
          </div>
        </div>
      </div>

      {/* ── Position (only shown when in trade) ─────────────────────── */}
      {inTrade && (
        <div className="grid grid-cols-4 gap-1.5">
          <div className="bg-[#111] rounded p-2 text-center">
            <div className="text-[9px] text-gray-600 uppercase mb-0.5">Lots</div>
            <div className="text-[10px] font-mono text-gray-200">
              {state.live_lots != null ? state.live_lots.toFixed(2) : "—"}
            </div>
          </div>
          <div className="bg-[#111] rounded p-2 text-center">
            <div className="text-[9px] text-gray-600 uppercase mb-0.5">SL</div>
            <div className="text-[10px] font-mono text-red-400">
              {fmtLevels(state.live_sl, symbol)}
            </div>
          </div>
          <div className="bg-[#111] rounded p-2 text-center">
            <div className="text-[9px] text-gray-600 uppercase mb-0.5">P&L</div>
            <div className={`text-[10px] font-mono font-semibold ${pnlClass(state.unrealised_pnl)}`}>
              {fmtPnl(state.unrealised_pnl)}
            </div>
          </div>
          <div className="bg-[#111] rounded p-2 text-center">
            <div className="text-[9px] text-gray-600 uppercase mb-0.5">Flags</div>
            <div className="text-[9px] font-mono flex flex-col gap-0.5 mt-0.5">
              <span className={state.is_inside_zone ? "text-blue-400" : "text-gray-700"}>
                {state.is_inside_zone ? "● ZONE" : "○ zone"}
              </span>
              <span className={state.is_be_secured ? "text-emerald-400" : "text-gray-700"}>
                {state.is_be_secured ? "● BE" : "○ be"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Daily Summary ────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 border-t border-[#1a1a1a] pt-3">
        <div>
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Trades today</div>
          <div className="text-[11px] font-mono text-gray-300">{state.daily_trades_count}</div>
        </div>
        <div>
          <div className="text-[9px] text-gray-600 uppercase mb-0.5">Daily P&L</div>
          <div className={`text-[11px] font-mono font-semibold ${pnlClass(state.daily_pnl_usd)}`}>
            {fmtPnl(state.daily_pnl_usd)}
          </div>
        </div>
        {/* Zone / BE badges even when not in trade */}
        {!inTrade && (state.is_inside_zone || state.is_be_secured) && (
          <div className="flex gap-1.5 ml-auto">
            {state.is_inside_zone && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400">ZONE</span>
            )}
            {state.is_be_secured && (
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">BE</span>
            )}
          </div>
        )}
      </div>

      {/* ── Top Ledger ───────────────────────────────────────────────── */}
      {ledger.length > 0 && (
        <div className="border-t border-[#1a1a1a] pt-3">
          <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-2">Recent Closed</div>
          <div className="space-y-1">
            {ledger.slice(0, 4).map((t, i) => {
              const sideColor = (t.side ?? "").toLowerCase().includes("buy") ? "text-emerald-400" : "text-red-400";
              return (
                <div key={t.ticket ?? i} className="grid grid-cols-[1fr_60px_60px_70px] gap-x-2 items-center text-[10px] font-mono">
                  <span className="text-gray-400">{t.symbol}</span>
                  <span className={sideColor}>{(t.side ?? "").toUpperCase()}</span>
                  <span className="text-gray-500">{fmtLevels(t.exit, t.symbol)}</span>
                  <span className={`text-right font-semibold ${pnlClass(t.pnl)}`}>{fmtPnl(t.pnl)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Trade Audit Log ──────────────────────────────────────────── */}
      <TradeAuditLog connectionId={connectionId} />
    </div>
  );
}
