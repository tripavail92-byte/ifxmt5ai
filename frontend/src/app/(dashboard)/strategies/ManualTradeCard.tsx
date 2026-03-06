"use client";

import { useState, useEffect, useTransition, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { Target } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { placeManualTrade } from "./actions";
import { createClient } from "@/utils/supabase/client";
import { usePriceFeed } from "@/hooks/usePriceFeed";

const CandlestickChart = dynamic(
  () => import("@/components/chart/CandlestickChart").then((m) => ({ default: m.CandlestickChart })),
  { ssr: false, loading: () => <div className="flex-1 bg-[#0a0a0a] animate-pulse rounded" /> }
);

interface Connection {
  id: string;
  broker_server: string;
  account_login: string;
}

interface Symbol {
  symbol: string;
  description: string;
  category: string;
}

const STORAGE_KEY_SYMBOLS = "ifx_chart_symbols";
const STORAGE_KEY_ACTIVE  = "ifx_chart_active";
const DEFAULT_SYMBOLS      = ["BTCUSDm", "BTCUSDm"];

// Per-symbol default zone percentages (matches backend asset_config_service)
const ZONE_DEFAULTS: Record<string, number> = {
  EURUSDm: 0.04, GBPUSDm: 0.06, USDJPYm: 0.06, USDCHFm: 0.06,
  EURGBPm: 0.06, AUDUSDm: 0.12, XAUUSDm: 0.125, NZDUSDm: 0.15,
  USDCADm: 0.14, USOILm: 0.25, BTCUSDm: 0.23, ETHUSDm: 0.85,
  // Without 'm' suffix variants
  EURUSD: 0.04, GBPUSD: 0.06, USDJPY: 0.06, USDCHF: 0.06,
  EURGBP: 0.06, AUDUSD: 0.12, XAUUSD: 0.125, NZDUSD: 0.15,
  USDCAD: 0.14, USOIL: 0.25, BTCUSD: 0.23, ETHUSD: 0.85,
};
const ZONE_DEFAULT_FALLBACK = 0.5;

// ─── State machine config ───────────────────────────────────────────────────

type SetupState = "IDLE" | "STALKING" | "PURGATORY" | "DEAD";

const SETUP_STATE_CFG: Record<SetupState, {
  label: string; dot: string; badge: string; glow: string; desc: string;
}> = {
  IDLE: {
    label: "IDLE",
    dot:   "bg-gray-500",
    badge: "bg-gray-500/15 text-gray-400 border-gray-500/30",
    glow:  "border-[#1e1e1e]",
    desc:  "Waiting — price away from zone",
  },
  STALKING: {
    label: "STALKING",
    dot:   "bg-blue-400 animate-pulse",
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    glow:  "border-blue-500/30",
    desc:  "Price in zone — watching closely",
  },
  PURGATORY: {
    label: "PURGATORY",
    dot:   "bg-amber-400 animate-pulse",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    glow:  "border-amber-500/30",
    desc:  "Wick broke loss edge — awaiting H1 close",
  },
  DEAD: {
    label: "DEAD",
    dot:   "bg-red-500",
    badge: "bg-red-500/15 text-red-400 border-red-500/30",
    glow:  "border-red-500/30",
    desc:  "H1 closed beyond loss edge — invalidated",
  },
};

function getZoneDefault(sym: string): number {
  return ZONE_DEFAULTS[sym] ?? ZONE_DEFAULT_FALLBACK;
}

function getDecimals(sym: string): number {
  if (/JPY|XAU|BTC|ETH|OIL/i.test(sym)) return 2;
  return 5;
}

function calcZone(ep: number, zp: number) {
  return {
    low:  ep * (1 - zp / 100),
    high: ep * (1 + zp / 100),
  };
}

function loadStoredSymbols(): [string, string] {
  if (typeof window === "undefined") return DEFAULT_SYMBOLS as [string, string];
  return DEFAULT_SYMBOLS as [string, string];
}

function loadStoredActive(slots: [string, string]): 0 | 1 {
  void slots;
  return 0;
}

export function ManualTradeCard({ connections }: { connections: Connection[] }) {
  // Auto-select only connection
  const autoConn = connections[0] ?? null;

  const [symbols, setSymbols] = useState<Symbol[]>([]);
  const [symbolSearch, setSymbolSearch] = useState("");
  const [showSymbolPicker, setShowSymbolPicker] = useState<0 | 1 | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Two pinned chart slots — persisted to localStorage
  const [slots, setSlots] = useState<[string, string]>(DEFAULT_SYMBOLS as [string, string]);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [hydrated, setHydrated] = useState(false);

  // Trade form
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [slValue, setSlValue] = useState<number | undefined>();
  const [tpValue, setTpValue] = useState<number | undefined>();
  const [formSymbol, setFormSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");

  // Zone state
  const [entryPrice, setEntryPrice] = useState<string>("");
  const [zonePercent, setZonePercent] = useState<number>(ZONE_DEFAULT_FALLBACK);
  const [showEntryZones, setShowEntryZones] = useState<boolean>(true);
  const [showTPZones, setShowTPZones] = useState<boolean>(true);

  // Setup tracking state
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupResult, setSetupResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // symbol → setup_id for upsert (persisted in memory per session)
  const [slotSetupIds, setSlotSetupIds] = useState<Record<string, string>>({});
  // Real-time state of the tracked setup for the active symbol
  const [activeSetupState, setActiveSetupState] = useState<SetupState | null>(null);

  // Live feed
  const { forming, lastClose, prices, isConnected, symbols: liveSymbols } = usePriceFeed(autoConn?.id);

  // Hydrate from localStorage on first render
  useEffect(() => {
    const fixed = DEFAULT_SYMBOLS as [string, string];
    setSlots(fixed);
    setActiveSlot(0);
    setFormSymbol("BTCUSDm");
    setHydrated(true);
  }, []);

  // Persist changes to localStorage
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY_SYMBOLS, JSON.stringify(slots));
  }, [slots, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY_ACTIVE, String(activeSlot));
  }, [activeSlot, hydrated]);

  // Load symbols for the auto-selected connection
  useEffect(() => {
    if (!autoConn) return;
    const supabase = createClient();
    supabase
      .from("mt5_symbols")
      .select("symbol, description, category")
      .eq("connection_id", autoConn.id)
      .order("symbol")
      .then(({ data }) => setSymbols(data ?? []));
  }, [autoConn?.id]);

  // Close picker on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowSymbolPicker(null);
        setSymbolSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = symbolSearch.length > 0
    ? symbols.filter(s =>
        s.symbol.toLowerCase().includes(symbolSearch.toLowerCase()) ||
        s.description?.toLowerCase().includes(symbolSearch.toLowerCase())
      ).slice(0, 60)
    : symbols.slice(0, 60);

  function selectSlotSymbol(slot: 0 | 1, sym: string) {
    const next: [string, string] = [...slots] as [string, string];
    next[slot] = sym;
    setSlots(next);
    setActiveSlot(slot);
    setFormSymbol(sym);
    setShowSymbolPicker(null);
    setSymbolSearch("");
  }

  function switchSlot(slot: 0 | 1) {
    setActiveSlot(slot);
    setFormSymbol(slots[slot]);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (autoConn) fd.set("connection_id", autoConn.id);
    setResult(null);
    startTransition(async () => {
      try {
        await placeManualTrade(fd);
        setResult({ ok: true, msg: "Trade queued — check Trades page for status." });
        setSlValue(undefined);
        setTpValue(undefined);
      } catch (err: unknown) {
        setResult({ ok: false, msg: err instanceof Error ? err.message : "Unknown error" });
      }
    });
  }

  async function handleTrackSetup() {
    if (!validEp || !autoConn) return;
    setSetupSaving(true);
    setSetupResult(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { data: newId, error } = await supabase.rpc("upsert_trading_setup", {
        p_user_id:       user.id,
        p_connection_id: autoConn.id,
        p_symbol:        formSymbol,
        p_side:          side,
        p_entry_price:   ep,
        p_zone_percent:  zonePercent,
        p_setup_id:      slotSetupIds[formSymbol] ?? null,
      });
      if (error) throw error;
      setSlotSetupIds(prev => ({ ...prev, [formSymbol]: newId as string }));
      setSetupResult({ ok: true, msg: `Setup tracked — state machine LIVE for ${formSymbol}` });
    } catch (err: unknown) {
      setSetupResult({ ok: false, msg: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSetupSaving(false);
    }
  }

  // Reset zone % when symbol changes
  useEffect(() => {
    const sym = slots[activeSlot];
    setZonePercent(getZoneDefault(sym));
    setEntryPrice("");
    setSlValue(undefined);
    setTpValue(undefined);
    setSetupResult(null);
    setActiveSetupState(null);
  }, [slots[activeSlot]]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to state-machine updates for the currently tracked setup
  useEffect(() => {
    const setupId = slotSetupIds[formSymbol];
    if (!setupId) { setActiveSetupState(null); return; }
    const sb = createClient();
    let cancelled = false;

    // Load current state immediately
    sb.from("trading_setups")
      .select("state")
      .eq("id", setupId)
      .single()
      .then(({ data }) => {
        if (!cancelled && data?.state) setActiveSetupState(data.state as SetupState);
      });

    // Subscribe to realtime row updates
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (sb as any)
      .channel(`setup-state-${setupId}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on("postgres_changes" as any, {
        event:  "UPDATE",
        schema: "public",
        table:  "trading_setups",
        filter: `id=eq.${setupId}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, (payload: any) => {
        if (payload.new?.state) setActiveSetupState(payload.new.state as SetupState);
      })
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotSetupIds[formSymbol], formSymbol]);

  // All subscribed pairs — fall back to known list while SSE connects
  const SUBSCRIBED = ["BTCUSDm","ETHUSDm","EURUSDm","GBPUSDm","USDJPYm","XAUUSDm","USDCADm","AUDUSDm","NZDUSDm","USDCHFm","EURGBPm","USOILm"];
  const tabSymbols = liveSymbols.length > 0 ? liveSymbols : SUBSCRIBED;
  const chartSym   = slots[activeSlot];
  const livePrice  = prices[chartSym];

  // Zone computation
  const ep = parseFloat(entryPrice);
  const validEp = !isNaN(ep) && ep > 0;
  const zone = useMemo(
    () => (validEp ? calcZone(ep, zonePercent) : null),
    [validEp, ep, zonePercent]
  );
  const dec = getDecimals(chartSym);
  const fmtZ = (v: number) => v.toFixed(dec);

  // Auto-fill SL / TP whenever zone or side changes
  useEffect(() => {
    if (!zone) return;
    if (side === "buy") {
      setSlValue(parseFloat(zone.low.toFixed(dec)));
      setTpValue(parseFloat(zone.high.toFixed(dec)));
    } else {
      setSlValue(parseFloat(zone.high.toFixed(dec)));
      setTpValue(parseFloat(zone.low.toFixed(dec)));
    }
  }, [zone?.low, zone?.high, side]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounded-xl border border-[#1e1e1e] bg-[#0a0a0a] overflow-hidden shadow-2xl">

      {/* ── Top bar: account badge + connection status ── */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#111] border-b border-[#1e1e1e]">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-gray-300">
            {autoConn ? `${autoConn.broker_server} · ${autoConn.account_login}` : "No active connection"}
          </span>
          {autoConn && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              ACTIVE
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-emerald-400 animate-pulse" : "bg-yellow-500"}`} />
          <span className="text-[10px] text-gray-500">{isConnected ? "LIVE" : "connecting…"}</span>
        </div>
      </div>

      {/* ── Symbol tab bar — all subscribed pairs ── */}
      <div
        className="flex overflow-x-auto border-b border-[#1e1e1e] bg-[#0d0d0d]"
        style={{ scrollbarWidth: "none" }}
      >
        {tabSymbols.map((sym) => {
          const live   = prices[sym];
          const isAct  = chartSym === sym;
          const digits = /JPY|XAU|BTC|ETH|OIL/i.test(sym) ? 2 : 5;
          return (
            <button
              key={sym}
              type="button"
              onClick={() => selectSlotSymbol(0, sym)}
              className={`flex-shrink-0 flex flex-col items-start px-3 py-2 border-b-2 transition-colors whitespace-nowrap
                ${isAct
                  ? "border-orange-500 bg-[#141414]"
                  : "border-transparent hover:bg-[#111] hover:border-gray-700"
                }`}
            >
              <span className={`font-mono font-semibold text-[11px] ${isAct ? "text-white" : "text-gray-500"}`}>
                {sym}
              </span>
              {live ? (
                <span className={`text-[10px] font-mono mt-0.5 ${isAct ? "text-emerald-400" : "text-gray-600"}`}>
                  {live.bid.toFixed(digits)}
                </span>
              ) : (
                <span className="text-[10px] text-gray-700 mt-0.5">—</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Chart ── */}
      <div className="bg-[#0a0a0a]">
        {hydrated && (
          <CandlestickChart
            symbol={chartSym}
            liveSymbol={chartSym}
            connId={autoConn?.id}
            sl={slValue}
            tp={tpValue}
            forming={forming}
            lastClose={lastClose}
            className="w-full"
          />
        )}
      </div>

      {/* ── Zone Panel ── */}
      <div className="border-t border-[#1e1e1e] bg-[#0d0d0d] px-4 py-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">

          {/* Entry Settings */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
              <Target className="size-3" /> Entry Settings
            </div>
            <div>
              <label className="block text-[10px] text-gray-600 mb-1">Entry Price</label>
              <input
                type="number"
                step="any"
                placeholder={livePrice ? livePrice.bid.toFixed(dec) : "0.00000"}
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                className="w-full h-8 rounded border border-[#2a2a2a] bg-[#111] text-xs text-white font-mono px-2.5 focus:outline-none focus:border-orange-500/50 placeholder:text-gray-700"
              />
            </div>
            {zone && (
              <div className="bg-[#141414] rounded-lg p-2.5 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Suggested Entry Zone</span>
                  <div className="flex items-center gap-1.5">
                    {slotSetupIds[formSymbol] && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 border border-orange-500/20 font-semibold">TRACKED</span>
                    )}
                    <span className="text-[10px] font-mono font-semibold text-blue-400">
                      {fmtZ(zone.low)} – {fmtZ(zone.high)}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Loss Edge (SL)</span>
                  <span className="text-[10px] font-mono font-semibold text-red-400">
                    {side === "buy" ? fmtZ(zone.low) : fmtZ(zone.high)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-gray-500">Target (TP)</span>
                  <span className="text-[10px] font-mono font-semibold text-emerald-400">
                    {side === "buy" ? fmtZ(zone.high) : fmtZ(zone.low)}
                  </span>
                </div>
              </div>
            )}

            {/* Track Setup button */}
            {validEp && (
              <button
                type="button"
                onClick={handleTrackSetup}
                disabled={setupSaving || !autoConn}
                className="w-full h-8 rounded text-[11px] font-bold transition-colors disabled:opacity-40
                  bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30
                  disabled:cursor-not-allowed"
              >
                {setupSaving
                  ? "Saving…"
                  : slotSetupIds[formSymbol]
                    ? `↻ Update ${formSymbol} Setup`
                    : `⊕ Track ${formSymbol} Zone`
                }
              </button>
            )}

            {/* Setup feedback */}
            {setupResult && (
              <div className={`px-2.5 py-1.5 rounded text-[11px] font-medium border
                ${setupResult.ok
                  ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20"
                }`}>
                {setupResult.msg}
              </div>
            )}
          </div>

          {/* Zone Controls */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
              Zone Controls
            </div>
            <label className="flex items-center justify-between p-2 bg-[#141414] rounded-lg cursor-pointer hover:bg-[#181818] transition-colors">
              <span className="text-xs text-gray-300">Show Entry Zones</span>
              <input
                type="checkbox"
                checked={showEntryZones}
                onChange={(e) => setShowEntryZones(e.target.checked)}
                className="size-3.5 accent-blue-500"
              />
            </label>
            <label className="flex items-center justify-between p-2 bg-[#141414] rounded-lg cursor-pointer hover:bg-[#181818] transition-colors">
              <span className="text-xs text-gray-300">Show Taking Profit Zones</span>
              <input
                type="checkbox"
                checked={showTPZones}
                onChange={(e) => setShowTPZones(e.target.checked)}
                className="size-3.5 accent-blue-500"
              />
            </label>
            <div className="p-2.5 bg-[#141414] rounded-lg space-y-2">
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-xs text-gray-300">Zone Percent</span>
                  <span className="block text-[10px] text-gray-600">Default: {getZoneDefault(chartSym).toFixed(2)}%</span>
                </div>
                <span className="text-xs font-semibold text-blue-400">{zonePercent.toFixed(2)}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="0.01"
                value={zonePercent}
                onChange={(e) => setZonePercent(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
              <div className="flex justify-between text-[10px] text-gray-600">
                <span>0%</span>
                <span>5%</span>
              </div>
            </div>

            {/* ── State Machine Badge ── */}
            {slotSetupIds[formSymbol] ? (() => {
              const cfg = activeSetupState
                ? SETUP_STATE_CFG[activeSetupState]
                : null;
              return (
                <div className={`rounded-lg border p-2.5 transition-all duration-500 ${
                  cfg ? cfg.glow : "border-[#1e1e1e]"
                }`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
                      State Machine
                    </span>
                    <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 font-semibold">
                      LIVE
                    </span>
                  </div>
                  {cfg ? (
                    <>
                      <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-full border w-fit ${ cfg.badge }`}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${ cfg.dot }`} />
                        <span className="text-[11px] font-bold tracking-widest">{cfg.label}</span>
                      </div>
                      <p className="text-[10px] text-gray-600 mt-1.5">{cfg.desc}</p>
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-gray-700 animate-pulse" />
                      <span className="text-[10px] text-gray-600">Loading state…</span>
                    </div>
                  )}
                </div>
              );
            })() : validEp ? (
              <div className="rounded-lg border border-dashed border-[#2a2a2a] p-2.5">
                <p className="text-[10px] text-gray-700 text-center">
                  Track setup above to activate state machine
                </p>
              </div>
            ) : null}
          </div>

        </div>
      </div>

      {/* ── Trade form ── */}
      <div className="border-t border-[#1e1e1e] bg-[#0d0d0d] px-4 py-4">
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-6 items-end">

          {/* Symbol — locked to active chart slot */}
          <input type="hidden" name="symbol" value={formSymbol} />
          <div className="space-y-1 lg:col-span-1">
            <Label className="text-[11px] text-gray-500 uppercase tracking-wide">Symbol</Label>
            <div className="h-8 flex items-center px-2 rounded border border-[#2a2a2a] bg-[#111] text-xs font-mono font-bold text-orange-400 select-none">
              {formSymbol || "—"}
            </div>
          </div>

          {/* Side */}
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500 uppercase tracking-wide">Side</Label>
            <Select name="side" required value={side} onValueChange={(v) => setSide(v as "buy" | "sell")}>
              <SelectTrigger className="h-8 text-xs bg-[#0a0a0a] border-[#2a2a2a] text-white">
                <SelectValue placeholder="Buy/Sell" />
              </SelectTrigger>
              <SelectContent className="bg-[#161616] border-[#2a2a2a]">
                <SelectItem value="buy"><span className="text-emerald-400 font-semibold">▲ Buy</span></SelectItem>
                <SelectItem value="sell"><span className="text-red-400 font-semibold">▼ Sell</span></SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Volume */}
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500 uppercase tracking-wide">Lots</Label>
            <Input name="volume" type="number" step="0.01" min="0.01" placeholder="0.01" required
              className="h-8 text-xs bg-[#0a0a0a] border-[#2a2a2a] text-white placeholder:text-gray-700" />
          </div>

          {/* SL */}
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500 uppercase tracking-wide">SL</Label>
            <Input name="sl" type="number" step="0.00001" placeholder="optional"
              value={slValue ?? ""}
              onChange={(e) => setSlValue(e.target.value ? parseFloat(e.target.value) : undefined)}
              className="h-8 text-xs bg-[#0a0a0a] border-[#2a2a2a] text-white placeholder:text-gray-700" />
          </div>

          {/* TP */}
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500 uppercase tracking-wide">TP</Label>
            <Input name="tp" type="number" step="0.00001" placeholder="optional"
              value={tpValue ?? ""}
              onChange={(e) => setTpValue(e.target.value ? parseFloat(e.target.value) : undefined)}
              className="h-8 text-xs bg-[#0a0a0a] border-[#2a2a2a] text-white placeholder:text-gray-700" />
          </div>

          {/* Submit */}
          <div className="space-y-1 lg:col-span-1">
            <Label className="text-[11px] text-transparent select-none">.</Label>
            <Button type="submit" disabled={isPending || !autoConn}
              className="h-8 w-full text-xs font-bold bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white">
              {isPending ? "Placing…" : "Place Trade"}
            </Button>
          </div>
        </form>

        {result && (
          <div className={`mt-3 px-3 py-2 rounded text-xs font-medium border
            ${result.ok
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
              : "bg-red-500/10 text-red-400 border-red-500/20"
            }`}>
            {result.msg}
          </div>
        )}
      </div>
    </div>
  );
}
