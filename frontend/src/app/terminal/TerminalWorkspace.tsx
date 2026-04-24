"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  History,
  Info,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Shield,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { activateTradeNow, placeManualTrade, saveTrackedSetup } from "@/app/(dashboard)/strategies/actions";
import { closeTradeJob, getConnectionExecutionModeAction, patchEaVisuals, saveConnectionExecutionMode, saveTerminalSettings } from "@/app/terminal/actions";
import type { EaExecutionMode } from "@/lib/ea-config";
import { CandlestickChart as CandlestickChartType } from "@/components/chart/CandlestickChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePriceFeed } from "@/hooks/usePriceFeed";
import { deriveDynamicStop, pivotWindowFromAiSensitivity, type StructureAnalysis, type StructureBar } from "@/lib/structure";
import { createClient } from "@/utils/supabase/client";
import type { MT5Position, PersistedTerminalSettings, StopMode, TerminalPreferences } from "@/app/terminal/types";

const CandlestickChart = dynamic(
  () => import("@/components/chart/CandlestickChart").then((m) => ({ default: m.CandlestickChart })),
  { ssr: false, loading: () => <div className="h-[320px] rounded-xl border border-[#242424] bg-[#0b0b0b] animate-pulse" /> }
) as typeof CandlestickChartType;

const SELECTED_QUOTE_FRESH_MS = 1_500;

type TerminalTab = "ai-trading" | "positions" | "copy-trading" | "manual-trades";
type SetupState = "IDLE" | "STALKING" | "PURGATORY" | "DEAD";

type Connection = {
  id: string;
  broker_server: string;
  account_login: string;
  status: string | null;
  is_active: boolean | null;
};

type SymbolRow = {
  symbol: string;
  description: string | null;
  category: string | null;
};

type SetupRow = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  entry_price: number | null;
  zone_percent: number | null;
  pivot?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  atr_zone_pct?: number | null;
  sl_pad_mult?: number | null;
  timeframe: string;
  ai_sensitivity?: number;
  trade_now_active?: boolean;
  state?: SetupState;
};

type HeartbeatRow = {
  connection_id: string;
  status: string;
  last_seen_at: string;
  last_metrics?: {
    balance?: number;
    equity?: number;
    margin?: number;
    free_margin?: number;
    margin_level?: number;
    profit?: number;
    open_positions?: MT5Position[];
  } | null;
};

type EaLiveStateRow = {
  connection_id: string;
  hud_status: string | null;
  updated_at: string;
  daily_trades?: number | null;
  win_rate?: number | null;
  avg_rr?: number | null;
  max_drawdown_pct?: number | null;
};

type NewsEvent = {
  id: string;
  currency: string;
  title: string;
  impact: "high" | "medium" | "low";
  scheduled_at_utc: string;
  category: string;
  provider: string;
};

type TradeJobRow = {
  id: string;
  connection_id: string;
  symbol: string;
  side: string;
  volume: number;
  sl: number | null;
  tp: number | null;
  status: string;
  created_at: string;
  idempotency_key?: string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
};

type RuntimeEventRow = {
  id: string;
  connection_id: string | null;
  level: string;
  component: string;
  message: string;
  created_at: string;
  details?: {
    event_kind?: string;
    setup_id?: string;
    symbol?: string;
    side?: string;
    reason?: string;
    close_price?: number;
  } | null;
};

type EaCommandRow = {
  id: string;
  connection_id: string;
  command_type: string;
  payload_json?: Record<string, unknown> | null;
  sequence_no: number;
  idempotency_key?: string | null;
  status: string;
  created_at: string;
  expires_at?: string | null;
};

type EaCommandAckRow = {
  id: string;
  command_id: string;
  connection_id: string;
  sequence_no: number;
  status: string;
  ack_payload_json?: Record<string, unknown> | null;
  acknowledged_at: string;
  created_at: string;
};

type EaRuntimeEventRow = {
  id: number;
  connection_id: string;
  event_type: string;
  payload?: Record<string, unknown> | null;
  created_at: string;
};

type ExecutionStreamItem = {
  id: string;
  source: "job" | "command" | "ack" | "event";
  title: string;
  detail: string;
  status: string;
  timestamp: string;
  error?: string | null;
};

const SUBSCRIBED_DEFAULT_SYMBOLS = [
  "EURUSD", "BTCUSD", "ETHUSD", "GBPUSD", "USDJPY", "XAUUSD",
  "USDCAD", "AUDUSD", "NZDUSD", "USDCHF", "EURGBP", "USOIL",
];

type SetupDraft = {
  entryPrice?: string;
  zonePercent?: number;
  side?: "buy" | "sell";
  aiSensitivity?: number;
};

type DynamicStopState = {
  analysis: StructureAnalysis | null;
  stop: number | null;
  referenceLevel: number | null;
  message: string | null;
};

type SymbolTradeSpec = {
  symbol: string;
  resolved_symbol?: string | null;
  digits?: number | null;
  point?: number | null;
  trade_tick_size?: number | null;
  trade_tick_value?: number | null;
  trade_contract_size?: number | null;
  volume_min?: number | null;
  volume_max?: number | null;
  volume_step?: number | null;
  currency_base?: string | null;
  currency_profit?: string | null;
  bid?: number | null;
  ask?: number | null;
  error?: string | null;
};

type TradeNowPlan = {
  version: 1;
  stopMode: StopMode;
  plannedStopLoss: number | null;
  plannedTakeProfit: number | null;
  riskMode: "percent" | "usd";
  riskPercent: number;
  riskUsd: number;
  riskRewardRatio: number;
  armedEntryPrice: number;
  armedAt: string;
};

type LotSizingDetails = {
  lotSize: number;
  rawLot: number;
  riskPerLot: number;
  actualRisk: number;
  stopDistancePips: number;
  pipValuePerLot: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  method: "broker" | "fallback";
  minLotExceedsRisk: boolean;
};

const navItems: Array<{ id: TerminalTab; label: string; icon: typeof Bot }> = [
  { id: "ai-trading", label: "AI Trading", icon: Bot },
  { id: "positions", label: "Positions", icon: TrendingUp },
  { id: "copy-trading", label: "Copy Trading", icon: Users },
  { id: "manual-trades", label: "Manual Trades", icon: Edit3 },
];

const SETUP_STATE_CFG: Record<SetupState, { label: string; badge: string; dot: string; desc: string }> = {
  IDLE: {
    label: "IDLE",
    badge: "bg-gray-500/15 text-gray-300 border-gray-500/20",
    dot: "bg-gray-400",
    desc: "Waiting — price away from zone",
  },
  STALKING: {
    label: "STALKING",
    badge: "bg-blue-500/15 text-blue-300 border-blue-500/20",
    dot: "bg-blue-400 animate-pulse",
    desc: "Price in zone — structure engine is actively watching",
  },
  PURGATORY: {
    label: "PURGATORY",
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/20",
    dot: "bg-amber-400 animate-pulse",
    desc: "Loss edge was wicked intrabar — waiting for H1 confirmation",
  },
  DEAD: {
    label: "DEAD",
    badge: "bg-red-500/15 text-red-300 border-red-500/20",
    dot: "bg-red-400",
    desc: "H1 close invalidated the setup",
  },
};

const ZONE_DEFAULTS: Record<string, number> = {
  EURUSDm: 0.04, GBPUSDm: 0.06, USDJPYm: 0.06, USDCHFm: 0.06,
  EURGBPm: 0.06, AUDUSDm: 0.12, XAUUSDm: 0.125, NZDUSDm: 0.15,
  USDCADm: 0.14, USOILm: 0.25, BTCUSDm: 0.23, ETHUSDm: 0.85,
  EURUSD: 0.04, GBPUSD: 0.06, USDJPY: 0.06, USDCHF: 0.06,
  EURGBP: 0.06, AUDUSD: 0.12, XAUUSD: 0.125, NZDUSD: 0.15,
  USDCAD: 0.14, USOIL: 0.25, BTCUSD: 0.23, ETHUSD: 0.85,
};

const ZONE_DEFAULT_FALLBACK = 0.5;
const STORAGE_KEY_DRAFTS = "ifx_terminal_setup_drafts";
const STORAGE_KEY_AI_SENS = "ifx_ai_sensitivity";
const STORAGE_KEY_TERMINAL_PREFS = "ifx_terminal_preferences_v1";
const STORAGE_KEY_TERMS_ACCEPTANCE = "ifx_terminal_terms_acceptance";
const TERMS_VERSION = "2026-03-28-v1";

function getZoneDefault(symbol: string): number {
  return ZONE_DEFAULTS[symbol] ?? ZONE_DEFAULT_FALLBACK;
}

function getDecimals(symbol: string): number {
  if (/JPY/i.test(symbol)) return 3;
  if (/XAU|XAG/i.test(symbol)) return 3;
  if (/BTC|ETH|OIL/i.test(symbol)) return 2;
  return 5;
}

function getPriceIncrement(symbol: string): number {
  return 1 / 10 ** getDecimals(symbol);
}

function normalizeStopMode(value: unknown): StopMode {
  return value === "ai_dynamic" ? "ai_dynamic" : "manual";
}

function formatStopModeLabel(stopMode: StopMode) {
  return stopMode === "ai_dynamic" ? "AI Dynamic" : "Manual";
}

function getStepDecimals(step: number) {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const normalized = step.toString().toLowerCase();
  if (normalized.includes("e-")) {
    const [, exp] = normalized.split("e-");
    return Number.parseInt(exp ?? "2", 10) || 2;
  }
  const [, fraction = ""] = normalized.split(".");
  return fraction.length;
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundVolumeDown(value: number, step: number) {
  if (!(value > 0)) return 0;
  if (!(step > 0)) return value;
  const decimals = Math.min(8, Math.max(0, getStepDecimals(step)));
  const floored = Math.floor((value + 1e-12) / step) * step;
  return Number(floored.toFixed(decimals));
}

function getLegacyRiskPerLot(symbol: string, stopDistance: number) {
  const pipSize = getPipSize(symbol);
  const stopDistancePips = pipSize > 0 ? stopDistance / pipSize : 0;
  const symbolUpper = symbol.toUpperCase();
  const pipValuePerLot = symbolUpper.includes("JPY") ? 9.0 : symbolUpper.includes("XAU") ? 10.0 : 10.0;
  return {
    stopDistancePips,
    pipValuePerLot,
    riskPerLot: stopDistancePips * pipValuePerLot,
  };
}

function getPipSize(symbol: string) {
  const normalized = symbol.toUpperCase();
  if (normalized.includes("JPY")) return 0.01;
  if (normalized.includes("XAU") || normalized.includes("GOLD")) return 0.1;
  if (normalized.includes("XAG") || normalized.includes("SILVER")) return 0.001;
  if (normalized.includes("BTC") || normalized.includes("ETH")) return 1.0;
  return 0.0001;
}

function getSelectedSetupTimeframe(): string {
  if (typeof window === "undefined") return "5m";
  const raw = (localStorage.getItem("ifx_chart_tf") ?? "M5").trim();
  const map: Record<string, string> = {
    M1: "1m",
    M3: "3m",
    M5: "5m",
    M15: "15m",
    M30: "30m",
    H1: "1h",
    H4: "4h",
    D1: "1d",
  };
  return map[raw] ?? "5m";
}

function calcZone(entryPrice: number, zonePercent: number) {
  return {
    low: entryPrice * (1 - zonePercent / 100),
    high: entryPrice * (1 + zonePercent / 100),
  };
}

function deriveDisplaySetupState(args: {
  runtimeState: SetupState | null;
  zone: { low: number; high: number } | null;
  price?: { bid: number; ask: number };
}): SetupState | null {
  const { runtimeState, zone, price } = args;
  if (!zone || !price) return runtimeState;
  if (runtimeState === "PURGATORY" || runtimeState === "DEAD") return runtimeState;

  const spreadTouchesZone = price.bid <= zone.high && price.ask >= zone.low;
  if (spreadTouchesZone) return "STALKING";

  return runtimeState;
}

function hudStatusToSetupState(status: string | null | undefined): SetupState | null {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (normalized === "ASLEEP") return "IDLE";
  if (normalized === "STALKING") return "STALKING";
  if (normalized === "PURGATORY") return "PURGATORY";
  if (normalized === "DEAD") return "DEAD";
  return null;
}

function loadDraft(symbol: string): SetupDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFTS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SetupDraft>;
    return parsed?.[symbol] ?? {};
  } catch {
    return {};
  }
}

function saveDraft(symbol: string, draft: SetupDraft) {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFTS);
    const parsed = raw ? (JSON.parse(raw) as Record<string, SetupDraft>) : {};
    parsed[symbol] = draft;
    localStorage.setItem(STORAGE_KEY_DRAFTS, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

function loadTerminalPreferences(): Partial<TerminalPreferences> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TERMINAL_PREFS);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<TerminalPreferences>;
  } catch {
    return {};
  }
}

function saveTerminalPreferences(prefs: TerminalPreferences) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_TERMINAL_PREFS, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

function loadAcceptedTermsVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY_TERMS_ACCEPTANCE);
  } catch {
    return null;
  }
}

function saveAcceptedTermsVersion(version: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (version) {
      localStorage.setItem(STORAGE_KEY_TERMS_ACCEPTANCE, version);
    } else {
      localStorage.removeItem(STORAGE_KEY_TERMS_ACCEPTANCE);
    }
  } catch {
    // ignore
  }
}

function fmtPrice(value: number, symbol: string) {
  return value.toFixed(getDecimals(symbol));
}

function stripBrokerSuffix(symbol?: string | null) {
  return String(symbol ?? "")
    .trim()
    .replace(/[._-]?(micro|mini)$/i, "")
    .replace(/m$/i, "")
    .toUpperCase();
}

function resolveLiveSymbolMatch(target: string | undefined, candidates: string[]) {
  const normalizedTarget = stripBrokerSuffix(target);
  if (!normalizedTarget) return undefined;
  const exact = candidates.find((sym) => sym === target);
  if (exact) return exact;
  return candidates.find((sym) => stripBrokerSuffix(sym) === normalizedTarget);
}

function fmtCurrency(value: number | undefined | null) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value ?? 0);
}

function buildTradeNowPlan(args: {
  stopMode: StopMode;
  stopLoss: number | null;
  takeProfit: number | null;
  riskMode: "percent" | "usd";
  riskPercent: number;
  riskUsd: number;
  riskRewardRatio: number;
  armedEntryPrice: number;
}) {
  const plan: TradeNowPlan = {
    version: 1,
    stopMode: args.stopMode,
    plannedStopLoss: args.stopLoss,
    plannedTakeProfit: args.takeProfit,
    riskMode: args.riskMode,
    riskPercent: args.riskPercent,
    riskUsd: args.riskUsd,
    riskRewardRatio: args.riskRewardRatio,
    armedEntryPrice: args.armedEntryPrice,
    armedAt: new Date().toISOString(),
  };
  return JSON.stringify({ tradePlan: plan });
}

function timeAgo(iso?: string | null) {
  if (!iso) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function StatusBadge({ status }: { status?: string | null }) {
  const normalized = (status ?? "offline").toLowerCase();
  const cls =
    normalized === "online"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/20"
      : normalized === "degraded"
        ? "bg-amber-500/15 text-amber-300 border-amber-500/20"
        : "bg-gray-500/15 text-gray-300 border-gray-500/20";

  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>{normalized}</span>;
}

export function TerminalWorkspace({ initialConnections, initialSettings, isAuthenticated }: { initialConnections: Connection[]; initialSettings: PersistedTerminalSettings | null; isAuthenticated: boolean }) {
  const router = useRouter();
  const supabase = createClient();
  const [activeTab, setActiveTab] = useState<TerminalTab>("ai-trading");
  const [connections] = useState<Connection[]>(initialConnections);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>(initialConnections[0]?.id ?? "");
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(isAuthenticated ? "" : SUBSCRIBED_DEFAULT_SYMBOLS[0]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [pivot, setPivot] = useState<string>("");
  const [tp1, setTp1] = useState<string>("");
  const [tp2, setTp2] = useState<string>("");
  const [atrZonePct, setAtrZonePct] = useState<number>(ZONE_DEFAULT_FALLBACK);
  const [slPadMult, setSlPadMult] = useState<number>(0.2);
  const [useAutoRR, setUseAutoRR] = useState(false);
  const [autoRR1, setAutoRR1] = useState<number>(1.0);
  const [autoRR2, setAutoRR2] = useState<number>(2.0);
  const [aiText, setAiText] = useState<string>("");
  const [showStruct, setShowStruct] = useState(false);
  const [smcLookback, setSmcLookback] = useState(400);
  const [minConfidence, setMinConfidence] = useState<number>(70);
  const [exitOnFlip, setExitOnFlip] = useState(true);
  const [useDeadSl, setUseDeadSl] = useState(true);
  const [slCooldownMin, setSlCooldownMin] = useState<number>(30);
  const [enableDiscord, setEnableDiscord] = useState(true);
  const [notifyOnSL, setNotifyOnSL] = useState(false);
  const [notifyOnTP, setNotifyOnTP] = useState(true);
  const [notifyDaily, setNotifyDaily] = useState(true);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState<string>("");
  // EA structure timeframes
  const [engineTf, setEngineTf] = useState<string>("M1");
  const [bossTimeframe, setBossTimeframe] = useState<string>("H1");
  const [slTimeframe, setSlTimeframe] = useState<string>("M5");
  const [beTimeframe, setBeTimeframe] = useState<string>("M10");
  // Session times
  const [londonStart, setLondonStart] = useState<string>("03:00");
  const [londonEnd, setLondonEnd] = useState<string>("11:00");
  const [nyStart, setNyStart] = useState<string>("08:00");
  const [nyEnd, setNyEnd] = useState<string>("17:00");
  const [asiaStart, setAsiaStart] = useState<string>("19:00");
  const [asiaEnd, setAsiaEnd] = useState<string>("03:00");
  // Trade execution
  const [baseMagic, setBaseMagic] = useState<number>(9180);
  const [tp1Pct, setTp1Pct] = useState<number>(75.0);
  const [usePartial, setUsePartial] = useState(true);
  const [useBE, setUseBE] = useState(true);
  const [breakEvenAfterTp1, setBreakEvenAfterTp1] = useState(true);
  const [closeEod, setCloseEod] = useState(true);
  const [eodTime, setEodTime] = useState<string>("23:50");
  const [visualsSaving, setVisualsSaving] = useState(false);
  const [showEntryZones, setShowEntryZones] = useState(true);
  const [showTPZones, setShowTPZones] = useState(true);
  const [stopMode, setStopMode] = useState<StopMode>("manual");
  const [aiSensitivity, setAiSensitivity] = useState<number>(5);
  const [slValue, setSlValue] = useState<number | undefined>();
  const [tpValue, setTpValue] = useState<number | undefined>();
  const [setupsBySymbol, setSetupsBySymbol] = useState<Record<string, SetupRow>>({});
  const [setupIdsBySymbol, setSetupIdsBySymbol] = useState<Record<string, string>>({});
  const [activeSetupState, setActiveSetupState] = useState<SetupState | null>(null);
  const [tradeNowBySymbol, setTradeNowBySymbol] = useState<Record<string, boolean>>({});
  const [accountHeartbeat, setAccountHeartbeat] = useState<HeartbeatRow | null>(null);
  const [eaLiveState, setEaLiveState] = useState<EaLiveStateRow | null>(null);
  const [recentJobs, setRecentJobs] = useState<TradeJobRow[]>([]);
  const [recentCommands, setRecentCommands] = useState<EaCommandRow[]>([]);
  const [recentCommandAcks, setRecentCommandAcks] = useState<EaCommandAckRow[]>([]);
  const [recentEaEvents, setRecentEaEvents] = useState<EaRuntimeEventRow[]>([]);
  const [executionMode, setExecutionMode] = useState<EaExecutionMode>("legacy-worker");
  const [executionModeSaving, setExecutionModeSaving] = useState(false);
  const [manualResult, setManualResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [setupResult, setSetupResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tradeNowResult, setTradeNowResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [setupSaving, setSetupSaving] = useState(false);
  const [tradeNowSaving, setTradeNowSaving] = useState(false);
  const [riskMode, setRiskMode] = useState<"percent" | "usd">("percent");
  const [riskPercent, setRiskPercent] = useState<number>(2);
  const [riskUsd, setRiskUsd] = useState<number>(200);
  const [maxTradesPerDay, setMaxTradesPerDay] = useState<number>(3);
  const [riskRewardRatio, setRiskRewardRatio] = useState<number>(2.5);
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState<number>(0);
  const [dailyProfitTargetUsd, setDailyProfitTargetUsd] = useState<number>(0);
  const [maxPositionSizeLots, setMaxPositionSizeLots] = useState<number>(0);
  const [maxDrawdownPercent, setMaxDrawdownPercent] = useState<number>(0);
  const [newsFilter, setNewsFilter] = useState(false);
  const [newsBeforeMin, setNewsBeforeMin] = useState<number>(30);
  const [newsAfterMin, setNewsAfterMin] = useState<number>(30);
  const [newsEvents, setNewsEvents] = useState<NewsEvent[]>([]);
  const [newsEventsLoading, setNewsEventsLoading] = useState(false);
  const [newsEventsStatus, setNewsEventsStatus] = useState<"ok" | "no_table" | "error" | "idle">("idle");
  const [sessions, setSessions] = useState({ london: true, newYork: true, asia: true });
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsSyncState, setSettingsSyncState] = useState<"idle" | "saving" | "saved" | "pending-migration" | "error">("idle");
  const [dynamicStopState, setDynamicStopState] = useState<DynamicStopState>({
    analysis: null,
    stop: null,
    referenceLevel: null,
    message: null,
  });
  const [symbolTradeSpec, setSymbolTradeSpec] = useState<SymbolTradeSpec | null>(null);
  const [dynamicStopLoading, setDynamicStopLoading] = useState(false);
  const [closingTickets, setClosingTickets] = useState<Set<number>>(new Set());
  const [orderType, setOrderType] = useState<"market" | "limit" | "stop">("market");
  const [pendingPrice, setPendingPrice] = useState<string>("");
  // Mirrors ManualTradeCard hydration guard — prevents chart SSR/client mismatch
  const [hydrated, setHydrated] = useState(false);
  const [pendingFeedSymbol, setPendingFeedSymbol] = useState<string | null>(null);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [authPromptIntent, setAuthPromptIntent] = useState<string>("queue trades");
  const [symbolChooserOpen, setSymbolChooserOpen] = useState(false);
  const [symbolChooserQuery, setSymbolChooserQuery] = useState("");

  useEffect(() => {
    if (selectedConnectionId) return;
    if (!connections.length) return;
    setSelectedConnectionId(connections[0].id);
  }, [connections, selectedConnectionId]);

  const {
    prices,
    forming,
    lastClose,
    symbols: liveSymbols,
    transportMode,
  } = usePriceFeed(selectedConnectionId || undefined, selectedSymbol || undefined);

  const selectedConnection = useMemo(
    () => connections.find((conn) => conn.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId]
  );

  const liveQuoteSymbols = useMemo(
    () => Object.keys(prices).filter((sym) => Boolean(prices[sym])),
    [prices]
  );
  const resolvedSelectedSymbol = useMemo(
    () => resolveLiveSymbolMatch(selectedSymbol || undefined, [...liveQuoteSymbols, ...(liveSymbols ?? [])]),
    [selectedSymbol, liveQuoteSymbols, liveSymbols]
  );
  const displaySymbol = resolvedSelectedSymbol || selectedSymbol || liveQuoteSymbols[0] || liveSymbols[0] || SUBSCRIBED_DEFAULT_SYMBOLS[0];
  const liveQuoteSymbol = resolvedSelectedSymbol ?? (selectedSymbol && prices[selectedSymbol] ? selectedSymbol : undefined) ?? liveQuoteSymbols[0] ?? liveSymbols[0] ?? displaySymbol;
  const livePrice = liveQuoteSymbol ? prices[liveQuoteSymbol] : undefined;
  const parsedEntry = parseFloat(pivot);
  const validEntry = Number.isFinite(parsedEntry) && parsedEntry > 0;
  const zone = useMemo(() => {
    if (!validEntry) return null;
    const thick = parsedEntry * (atrZonePct / 100);
    return { low: parsedEntry - thick * 0.5, high: parsedEntry + thick * 0.5 };
  }, [parsedEntry, validEntry, atrZonePct]);
  const activeSymbol = displaySymbol;
  const aiManagedExecution = stopMode === "ai_dynamic";
  const effectiveStop = useMemo(() => {
    if (!selectedSymbol) return 0;
    if (typeof slValue === "number" && Number.isFinite(slValue)) return slValue;
    return 0;
  }, [selectedSymbol, slValue]);
  const accountBalance = Number(accountHeartbeat?.last_metrics?.balance ?? 10000);
  const accountEquity = Number(accountHeartbeat?.last_metrics?.equity ?? accountBalance);
  const margin = Number(accountHeartbeat?.last_metrics?.margin ?? 0);
  const freeMargin = Number(accountHeartbeat?.last_metrics?.free_margin ?? Math.max(0, accountEquity - margin));
  const openPositions: MT5Position[] = accountHeartbeat?.last_metrics?.open_positions ?? [];
  const riskAmount = riskMode === "percent" ? (accountEquity * riskPercent) / 100 : riskUsd;
  const stopDistance = validEntry && effectiveStop > 0 ? Math.abs(parsedEntry - effectiveStop) : 0;
  const lotSizing = useMemo<LotSizingDetails>(() => {
    const volumeMinRaw = toFiniteNumber(symbolTradeSpec?.volume_min, 0.01);
    const volumeMaxRaw = toFiniteNumber(symbolTradeSpec?.volume_max, 100);
    const volumeStepRaw = toFiniteNumber(symbolTradeSpec?.volume_step, 0.01);
    const volumeMin = volumeMinRaw > 0 ? volumeMinRaw : 0.01;
    const volumeMax = volumeMaxRaw > 0 ? volumeMaxRaw : 100;
    const volumeStep = volumeStepRaw > 0 ? volumeStepRaw : 0.01;

    const tickSize = toFiniteNumber(symbolTradeSpec?.trade_tick_size, 0);
    const tickValue = toFiniteNumber(symbolTradeSpec?.trade_tick_value, 0);
    const pipSize = getPipSize(displaySymbol);
    const safeRiskAmount = toFiniteNumber(riskAmount, 0);
    const safeStopDistance = toFiniteNumber(stopDistance, 0);

    let method: "broker" | "fallback" = "fallback";
    let riskPerLot = 0;
    let stopDistancePips = 0;
    let pipValuePerLot = 0;

    if (safeStopDistance > 0) {
      stopDistancePips = pipSize > 0 ? safeStopDistance / pipSize : 0;
      if (tickSize > 0 && tickValue > 0) {
        pipValuePerLot = tickValue * (pipSize / tickSize);
        riskPerLot = stopDistancePips * pipValuePerLot;
        method = "broker";
      } else {
        const legacy = getLegacyRiskPerLot(displaySymbol, safeStopDistance);
        stopDistancePips = legacy.stopDistancePips;
        pipValuePerLot = legacy.pipValuePerLot;
        riskPerLot = legacy.riskPerLot;
      }
    }

    const safeRiskPerLot = toFiniteNumber(riskPerLot, 0);
    const rawLot = safeRiskPerLot > 0 && safeRiskAmount > 0 ? safeRiskAmount / safeRiskPerLot : volumeMin;
    const roundedLot = rawLot > 0 ? roundVolumeDown(rawLot, volumeStep) : 0;
    const boundedLot = Math.min(volumeMax, Math.max(volumeMin, roundedLot > 0 ? roundedLot : volumeMin));
    const lotSize = Number(
      toFiniteNumber(boundedLot, volumeMin).toFixed(
        Math.min(8, Math.max(2, getStepDecimals(volumeStep)))
      )
    );
    const actualRisk = safeRiskPerLot > 0 ? safeRiskPerLot * lotSize : 0;

    return {
      lotSize,
      rawLot,
      riskPerLot: safeRiskPerLot,
      actualRisk,
      stopDistancePips,
      pipValuePerLot,
      volumeMin,
      volumeMax,
      volumeStep,
      method,
      minLotExceedsRisk: safeRiskPerLot > 0 && safeRiskAmount > 0 && rawLot < volumeMin && actualRisk > safeRiskAmount,
    };
  }, [displaySymbol, riskAmount, stopDistance, symbolTradeSpec]);
  const lotSuggestion = lotSizing.lotSize;
  const pivotWindow = pivotWindowFromAiSensitivity(aiSensitivity);
  const targetSuggestion = useMemo(() => {
    if (!validEntry || stopDistance <= 0) return undefined;
    const raw = side === "buy"
      ? parsedEntry + stopDistance * riskRewardRatio
      : parsedEntry - stopDistance * riskRewardRatio;
    return Number(raw.toFixed(getDecimals(displaySymbol)));
  }, [displaySymbol, parsedEntry, riskRewardRatio, side, stopDistance, validEntry]);
  const effectiveTakeProfit = typeof tpValue === "number" && Number.isFinite(tpValue) && tpValue > 0
    ? tpValue
    : targetSuggestion;
  const todaysTradeCount = useMemo(() => {
    const today = new Date();
    return recentJobs.filter((job) => {
      const created = new Date(job.created_at);
      return created.getFullYear() === today.getFullYear()
        && created.getMonth() === today.getMonth()
        && created.getDate() === today.getDate();
    }).length;
  }, [recentJobs]);
  const executionStreamItems = useMemo<ExecutionStreamItem[]>(() => {
    if (executionMode === "legacy-worker") {
      return recentJobs.map((job) => ({
        id: `job-${job.id}`,
        source: "job",
        title: job.symbol,
        detail: `${job.side.toUpperCase()} · ${job.volume} lots`,
        status: job.status,
        timestamp: job.created_at,
        error: job.error ?? null,
      }));
    }

    const commands = recentCommands.map((command) => {
      const payload = (command.payload_json ?? {}) as Record<string, unknown>;
      const symbol = typeof payload.symbol === "string" ? payload.symbol : command.command_type;
      const side = typeof payload.side === "string" ? payload.side.toUpperCase() : command.command_type;
      const volume = typeof payload.volume === "number" ? ` · ${payload.volume} lots` : "";
      return {
        id: `command-${command.id}`,
        source: "command" as const,
        title: symbol,
        detail: `${side}${volume} · seq ${command.sequence_no}`,
        status: command.status,
        timestamp: command.created_at,
        error: null,
      };
    });

    const acks = recentCommandAcks.map((ack) => {
      const payload = (ack.ack_payload_json ?? {}) as Record<string, unknown>;
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      return {
        id: `ack-${ack.id}`,
        source: "ack" as const,
        title: `Ack #${ack.sequence_no}`,
        detail: reason ? `${ack.status} · ${reason}` : `${ack.status} · command ${ack.command_id}`,
        status: ack.status,
        timestamp: ack.acknowledged_at || ack.created_at,
        error: ack.status === "rejected" ? reason : null,
      };
    });

    const events = recentEaEvents.map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const symbol = typeof payload.symbol === "string" ? payload.symbol : event.event_type;
      const reason = typeof payload.reason === "string" ? payload.reason : "EA runtime event";
      const status = typeof payload.status === "string" ? payload.status : event.event_type;
      return {
        id: `event-${event.id}`,
        source: "event" as const,
        title: symbol,
        detail: reason,
        status,
        timestamp: event.created_at,
        error: status === "rejected" ? reason : null,
      };
    });

    return [...commands, ...acks, ...events]
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .slice(0, 30);
  }, [executionMode, recentCommandAcks, recentCommands, recentEaEvents, recentJobs]);
  const latestCommandAck = useMemo(() => {
    if (!recentCommandAcks.length) return null;
    return [...recentCommandAcks]
      .sort((left, right) => new Date(right.acknowledged_at || right.created_at).getTime() - new Date(left.acknowledged_at || left.created_at).getTime())[0] ?? null;
  }, [recentCommandAcks]);
  const executionGuardPreview = useMemo(() => {
    if (!isAuthenticated) return "Sign in to queue trades, arm Trade Now, or save monitored setups to your MT5 connection.";
    if (!termsAccepted) return "Accept the current terminal terms before queueing live MT5 execution.";
    if (!(riskAmount > 0)) return "Risk amount must be greater than zero.";
    if (!aiManagedExecution && lotSizing.minLotExceedsRisk) {
      return `Minimum broker lot ${lotSizing.volumeMin.toFixed(2)} risks ${fmtCurrency(lotSizing.actualRisk)}, above your selected risk ${fmtCurrency(riskAmount)}.`;
    }
    if (maxTradesPerDay > 0 && todaysTradeCount >= maxTradesPerDay) {
      return `Daily trade limit reached: ${todaysTradeCount}/${maxTradesPerDay}.`;
    }
    // Max position size
    if (maxPositionSizeLots > 0 && lotSuggestion > maxPositionSizeLots) {
      return `Lot size ${lotSuggestion.toFixed(2)} exceeds your max position size of ${maxPositionSizeLots} lots.`;
    }
    // Daily loss limit — checked against floating P&L of all open positions
    const floatingPnl = openPositions.reduce((sum, p) => sum + p.profit + p.swap, 0);
    if (dailyLossLimitUsd > 0 && floatingPnl < -dailyLossLimitUsd) {
      return `Daily loss limit of $${dailyLossLimitUsd} reached (floating: ${fmtCurrency(floatingPnl)}).`;
    }
    // Daily profit target — lock out new trades when hit
    if (dailyProfitTargetUsd > 0 && floatingPnl >= dailyProfitTargetUsd) {
      return `Daily profit target of $${dailyProfitTargetUsd} reached — trading locked for today.`;
    }
    // Max drawdown
    if (maxDrawdownPercent > 0 && accountBalance > 0) {
      const drawdown = ((accountBalance - accountEquity) / accountBalance) * 100;
      if (drawdown >= maxDrawdownPercent) {
        return `Max drawdown of ${maxDrawdownPercent}% reached (current: ${drawdown.toFixed(1)}%).`;
      }
    }
    return null;
  }, [accountBalance, accountEquity, aiManagedExecution, dailyLossLimitUsd, dailyProfitTargetUsd, isAuthenticated, lotSizing.actualRisk, lotSizing.minLotExceedsRisk, lotSizing.volumeMin, lotSuggestion, maxDrawdownPercent, maxPositionSizeLots, maxTradesPerDay, openPositions, riskAmount, termsAccepted, todaysTradeCount]);

  useEffect(() => {
    try {
      const raw = (localStorage.getItem(STORAGE_KEY_AI_SENS) ?? "5").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) {
        setAiSensitivity(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const serverPrefs = initialSettings?.preferences ?? {};
    const localPrefs = loadTerminalPreferences();
    const mergedPrefs: Partial<TerminalPreferences> = {
      ...serverPrefs,
      ...localPrefs,
      sessions: {
        london: serverPrefs.sessions?.london ?? true,
        newYork: serverPrefs.sessions?.newYork ?? true,
        asia: serverPrefs.sessions?.asia ?? true,
        ...(localPrefs.sessions ?? {}),
      },
    };

    if (mergedPrefs.riskMode === "percent" || mergedPrefs.riskMode === "usd") setRiskMode(mergedPrefs.riskMode);
    if (typeof mergedPrefs.riskPercent === "number") setRiskPercent(mergedPrefs.riskPercent);
    if (typeof mergedPrefs.riskUsd === "number") setRiskUsd(mergedPrefs.riskUsd);
    if (typeof mergedPrefs.maxTradesPerDay === "number") setMaxTradesPerDay(mergedPrefs.maxTradesPerDay);
    if (typeof mergedPrefs.riskRewardRatio === "number") setRiskRewardRatio(mergedPrefs.riskRewardRatio);
    if (typeof mergedPrefs.dailyLossLimitUsd === "number") setDailyLossLimitUsd(mergedPrefs.dailyLossLimitUsd);
    if (typeof mergedPrefs.dailyProfitTargetUsd === "number") setDailyProfitTargetUsd(mergedPrefs.dailyProfitTargetUsd);
    if (typeof mergedPrefs.maxPositionSizeLots === "number") setMaxPositionSizeLots(mergedPrefs.maxPositionSizeLots);
    if (typeof mergedPrefs.maxDrawdownPercent === "number") setMaxDrawdownPercent(mergedPrefs.maxDrawdownPercent);
    if (typeof mergedPrefs.newsFilter === "boolean") setNewsFilter(mergedPrefs.newsFilter);
    if (typeof mergedPrefs.newsBeforeMin === "number") setNewsBeforeMin(mergedPrefs.newsBeforeMin);
    if (typeof mergedPrefs.newsAfterMin === "number") setNewsAfterMin(mergedPrefs.newsAfterMin);
    if (typeof mergedPrefs.showEntryZones === "boolean") setShowEntryZones(mergedPrefs.showEntryZones);
    if (typeof mergedPrefs.showTPZones === "boolean") setShowTPZones(mergedPrefs.showTPZones);
    setStopMode(normalizeStopMode(mergedPrefs.stopMode));
    if (typeof mergedPrefs.slPadMult === "number") setSlPadMult(mergedPrefs.slPadMult);
    if (typeof mergedPrefs.minConfidence === "number") setMinConfidence(mergedPrefs.minConfidence);
    if (typeof mergedPrefs.exitOnFlip === "boolean") setExitOnFlip(mergedPrefs.exitOnFlip);
    if (typeof mergedPrefs.useDeadSl === "boolean") setUseDeadSl(mergedPrefs.useDeadSl);
    if (typeof mergedPrefs.slCooldownMin === "number") setSlCooldownMin(mergedPrefs.slCooldownMin);
    if (typeof mergedPrefs.enableDiscord === "boolean") setEnableDiscord(mergedPrefs.enableDiscord);
    if (typeof mergedPrefs.notifyOnSL === "boolean") setNotifyOnSL(mergedPrefs.notifyOnSL);
    if (typeof mergedPrefs.notifyOnTP === "boolean") setNotifyOnTP(mergedPrefs.notifyOnTP);
    if (typeof mergedPrefs.notifyDaily === "boolean") setNotifyDaily(mergedPrefs.notifyDaily);
    if (typeof mergedPrefs.discordWebhookUrl === "string") setDiscordWebhookUrl(mergedPrefs.discordWebhookUrl);
    if (typeof mergedPrefs.engineTf === "string" && mergedPrefs.engineTf) setEngineTf(mergedPrefs.engineTf);
    if (typeof mergedPrefs.bossTimeframe === "string" && mergedPrefs.bossTimeframe) setBossTimeframe(mergedPrefs.bossTimeframe);
    if (typeof mergedPrefs.slTimeframe === "string" && mergedPrefs.slTimeframe) setSlTimeframe(mergedPrefs.slTimeframe);
    if (typeof mergedPrefs.beTimeframe === "string" && mergedPrefs.beTimeframe) setBeTimeframe(mergedPrefs.beTimeframe);
    if (typeof mergedPrefs.londonStart === "string" && mergedPrefs.londonStart) setLondonStart(mergedPrefs.londonStart);
    if (typeof mergedPrefs.londonEnd === "string" && mergedPrefs.londonEnd) setLondonEnd(mergedPrefs.londonEnd);
    if (typeof mergedPrefs.nyStart === "string" && mergedPrefs.nyStart) setNyStart(mergedPrefs.nyStart);
    if (typeof mergedPrefs.nyEnd === "string" && mergedPrefs.nyEnd) setNyEnd(mergedPrefs.nyEnd);
    if (typeof mergedPrefs.asiaStart === "string" && mergedPrefs.asiaStart) setAsiaStart(mergedPrefs.asiaStart);
    if (typeof mergedPrefs.asiaEnd === "string" && mergedPrefs.asiaEnd) setAsiaEnd(mergedPrefs.asiaEnd);
    if (typeof mergedPrefs.baseMagic === "number") setBaseMagic(mergedPrefs.baseMagic);
    if (typeof mergedPrefs.tp1Pct === "number") setTp1Pct(mergedPrefs.tp1Pct);
    if (typeof mergedPrefs.usePartial === "boolean") setUsePartial(mergedPrefs.usePartial);
    if (typeof mergedPrefs.useBE === "boolean") setUseBE(mergedPrefs.useBE);
    if (typeof mergedPrefs.breakEvenAfterTp1 === "boolean") setBreakEvenAfterTp1(mergedPrefs.breakEvenAfterTp1);
    if (typeof mergedPrefs.closeEod === "boolean") setCloseEod(mergedPrefs.closeEod);
    if (typeof mergedPrefs.eodTime === "string" && mergedPrefs.eodTime) setEodTime(mergedPrefs.eodTime);
    if (typeof mergedPrefs.showStruct === "boolean") setShowStruct(mergedPrefs.showStruct);
    if (typeof mergedPrefs.smcLookback === "number") setSmcLookback(mergedPrefs.smcLookback);
    if (mergedPrefs.sessions) {
      setSessions({
        london: Boolean(mergedPrefs.sessions.london),
        newYork: Boolean(mergedPrefs.sessions.newYork),
        asia: Boolean(mergedPrefs.sessions.asia),
      });
    }

    const localTermsAccepted = loadAcceptedTermsVersion() === TERMS_VERSION;
    const serverTermsAccepted = initialSettings?.termsVersion === TERMS_VERSION;
    setTermsAccepted(localTermsAccepted || serverTermsAccepted);
    setSettingsLoaded(true);
    setSettingsSyncState(initialSettings ? "saved" : "idle");
  }, [initialSettings]);

  // Mark client hydration complete — same pattern as ManualTradeCard on strategies page
  useEffect(() => { setHydrated(true); }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_AI_SENS, String(aiSensitivity));
    } catch {
      // ignore
    }
  }, [aiSensitivity]);

  useEffect(() => {
    saveTerminalPreferences({
      riskMode,
      riskPercent,
      riskUsd,
      maxTradesPerDay,
      riskRewardRatio,
      dailyLossLimitUsd,
      dailyProfitTargetUsd,
      maxPositionSizeLots,
      maxDrawdownPercent,
      newsFilter,
      newsBeforeMin,
      newsAfterMin,
      sessions,
      showEntryZones,
      showTPZones,
      stopMode,
      slPadMult,
      minConfidence,
      exitOnFlip,
      useDeadSl,
      slCooldownMin,
      enableDiscord,
      notifyOnSL,
      notifyOnTP,
      notifyDaily,
      discordWebhookUrl,
      engineTf,
      bossTimeframe,
      slTimeframe,
      beTimeframe,
      londonStart,
      londonEnd,
      nyStart,
      nyEnd,
      asiaStart,
      asiaEnd,
      baseMagic,
      tp1Pct,
      usePartial,
      useBE,
      breakEvenAfterTp1,
      closeEod,
      eodTime,
      showStruct,
      smcLookback,
    });
  }, [
    dailyLossLimitUsd,
    dailyProfitTargetUsd,
    maxDrawdownPercent,
    maxPositionSizeLots,
    maxTradesPerDay,
    newsAfterMin,
    newsBeforeMin,
    newsFilter,
    riskMode,
    riskPercent,
    riskRewardRatio,
    riskUsd,
    sessions,
    showEntryZones,
    showTPZones,
    stopMode,
    slPadMult,
    minConfidence,
    exitOnFlip,
    useDeadSl,
    slCooldownMin,
    enableDiscord,
    notifyOnSL,
    notifyOnTP,
    notifyDaily,
    discordWebhookUrl,
    engineTf,
    bossTimeframe,
    slTimeframe,
    beTimeframe,
    londonStart,
    londonEnd,
    nyStart,
    nyEnd,
    asiaStart,
    asiaEnd,
    baseMagic,
    tp1Pct,
    usePartial,
    useBE,
    breakEvenAfterTp1,
    closeEod,
    eodTime,
    showStruct,
    smcLookback,
  ]);

  useEffect(() => {
    saveAcceptedTermsVersion(termsAccepted ? TERMS_VERSION : null);
  }, [termsAccepted]);

  // Fetch upcoming economic events once on mount; also callable via refresh button
  async function fetchNewsEvents() {
    setNewsEventsLoading(true);
    try {
      const res = await fetch("/api/news/upcoming?hours=48&impacts=high,medium");
      if (!res.ok) { setNewsEventsStatus("error"); return; }
      const json = await res.json() as { events: NewsEvent[]; status?: string };
      setNewsEvents(json.events ?? []);
      setNewsEventsStatus((json.status as "ok" | "no_table" | "error") ?? "ok");
    } catch {
      setNewsEventsStatus("error");
    } finally {
      setNewsEventsLoading(false);
    }
  }

  useEffect(() => {
    if (!isAuthenticated) {
      setNewsEvents([]);
      setNewsEventsStatus("idle");
      return;
    }
    void fetchNewsEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !settingsLoaded) return;
    const timeout = window.setTimeout(() => {
      setSettingsSyncState("saving");
      void saveTerminalSettings({
        connectionId: selectedConnectionId,
        preferences: {
          riskMode,
          riskPercent,
          riskUsd,
          maxTradesPerDay,
          riskRewardRatio,
          dailyLossLimitUsd,
          dailyProfitTargetUsd,
          maxPositionSizeLots,
          maxDrawdownPercent,
          newsFilter,
          newsBeforeMin,
          newsAfterMin,
          sessions,
          showEntryZones,
          showTPZones,
          stopMode,
          slPadMult,
          minConfidence,
          exitOnFlip,
          useDeadSl,
          slCooldownMin,
          enableDiscord,
          notifyOnSL,
          notifyOnTP,
          notifyDaily,
          discordWebhookUrl,
          engineTf,
          bossTimeframe,
          slTimeframe,
          beTimeframe,
          londonStart,
          londonEnd,
          nyStart,
          nyEnd,
          asiaStart,
          asiaEnd,
          baseMagic,
          tp1Pct,
          usePartial,
          useBE,
          breakEvenAfterTp1,
          closeEod,
          eodTime,
        },
        termsVersion: TERMS_VERSION,
        termsAccepted,
      })
        .then((result) => {
          if (!result.ok && result.reason === "missing_table") {
            setSettingsSyncState("pending-migration");
            return;
          }
          setSettingsSyncState("saved");
        })
        .catch(() => {
          setSettingsSyncState("error");
        });
    }, 900);

    return () => window.clearTimeout(timeout);
  }, [
    dailyLossLimitUsd,
    dailyProfitTargetUsd,
    maxDrawdownPercent,
    maxPositionSizeLots,
    maxTradesPerDay,
    newsAfterMin,
    newsBeforeMin,
    newsFilter,
    riskMode,
    riskPercent,
    riskRewardRatio,
    riskUsd,
    sessions,
    settingsLoaded,
    showEntryZones,
    showTPZones,
    stopMode,
    slPadMult,
    minConfidence,
    exitOnFlip,
    useDeadSl,
    slCooldownMin,
    enableDiscord,
    notifyOnSL,
    notifyOnTP,
    notifyDaily,
    discordWebhookUrl,
    engineTf,
    bossTimeframe,
    slTimeframe,
    beTimeframe,
    londonStart,
    londonEnd,
    nyStart,
    nyEnd,
    asiaStart,
    asiaEnd,
    baseMagic,
    tp1Pct,
    usePartial,
    useBE,
    breakEvenAfterTp1,
    closeEod,
    eodTime,
    isAuthenticated,
    termsAccepted,
  ]);

  useEffect(() => {
    if (!selectedConnectionId) {
      setSymbols([]);
      setSelectedSymbol("");
      setAccountHeartbeat(null);
      setRecentJobs([]);
      setRecentCommands([]);
      setRecentCommandAcks([]);
      setRecentEaEvents([]);
      setSetupsBySymbol({});
      setSetupIdsBySymbol({});
      setTradeNowBySymbol({});
      setActiveSetupState(null);
      return;
    }
    if (!isAuthenticated) {
      setSymbols([]);
      setAccountHeartbeat(null);
      setRecentJobs([]);
      setRecentCommands([]);
      setRecentCommandAcks([]);
      setRecentEaEvents([]);
      setSetupsBySymbol({});
      setSetupIdsBySymbol({});
      setTradeNowBySymbol({});
      setActiveSetupState(null);
      return;
    }
    let cancelled = false;

    void getConnectionExecutionModeAction(selectedConnectionId)
      .then((mode) => {
        if (!cancelled) setExecutionMode(mode);
      })
      .catch(() => {
        if (!cancelled) setExecutionMode("legacy-worker");
      });

    const load = async () => {
      const [{ data: symbolRows }, { data: setupRows }, { data: setupFlags }, { data: heartbeatRow }, { data: eaLiveStateRow }, { data: jobs }, { data: commands }, { data: commandAcks }, { data: eaEvents }] = await Promise.all([
        supabase.from("mt5_symbols").select("symbol, description, category").eq("connection_id", selectedConnectionId).order("symbol"),
        supabase.rpc("get_setups_for_connection", { p_connection_id: selectedConnectionId }),
        supabase
          .from("trading_setups")
          .select("id, symbol, state, trade_now_active")
          .eq("connection_id", selectedConnectionId)
          .eq("is_active", true),
        supabase.from("mt5_worker_heartbeats").select("connection_id, status, last_seen_at, last_metrics").eq("connection_id", selectedConnectionId).maybeSingle(),
        supabase.from("ea_live_state").select("connection_id, hud_status, updated_at, daily_trades").eq("connection_id", selectedConnectionId).maybeSingle(),
        supabase.from("trade_jobs").select("id, connection_id, symbol, side, volume, sl, tp, status, created_at, idempotency_key, error, result").eq("connection_id", selectedConnectionId).order("created_at", { ascending: false }).limit(30),
        supabase.from("ea_commands").select("id, connection_id, command_type, payload_json, sequence_no, idempotency_key, status, created_at, expires_at").eq("connection_id", selectedConnectionId).order("created_at", { ascending: false }).limit(30),
        supabase.from("ea_command_acks").select("id, command_id, connection_id, sequence_no, status, ack_payload_json, acknowledged_at, created_at").eq("connection_id", selectedConnectionId).order("acknowledged_at", { ascending: false }).limit(30),
        supabase.from("ea_runtime_events").select("id, connection_id, event_type, payload, created_at").eq("connection_id", selectedConnectionId).order("created_at", { ascending: false }).limit(30),
      ]);

      if (cancelled) return;
      setSymbols((symbolRows ?? []) as SymbolRow[]);
      setAccountHeartbeat((heartbeatRow ?? null) as HeartbeatRow | null);
      setEaLiveState((eaLiveStateRow ?? null) as EaLiveStateRow | null);
      setRecentJobs((jobs ?? []) as TradeJobRow[]);
      setRecentCommands((commands ?? []) as EaCommandRow[]);
      setRecentCommandAcks((commandAcks ?? []) as EaCommandAckRow[]);
      setRecentEaEvents((eaEvents ?? []) as EaRuntimeEventRow[]);

      const rows = (setupRows ?? []) as SetupRow[];
      const flagsBySymbol = new Map(
        ((setupFlags ?? []) as Array<{ id: string; symbol: string; state?: string | null; trade_now_active?: boolean | null }>)
          .filter((row) => Boolean(row?.symbol))
          .map((row) => [row.symbol, row])
      );
      const nextBySymbol: Record<string, SetupRow> = {};
      const nextIds: Record<string, string> = {};
      const nextTradeNow: Record<string, boolean> = {};
      for (const row of rows) {
        if (!row?.symbol) continue;
        const flags = flagsBySymbol.get(row.symbol);
        const mergedRow: SetupRow = {
          ...row,
          state: (flags?.state as SetupState | undefined) ?? row.state,
          trade_now_active: typeof flags?.trade_now_active === "boolean" ? flags.trade_now_active : row.trade_now_active,
        };
        if (!nextBySymbol[row.symbol]) nextBySymbol[row.symbol] = mergedRow;
        nextIds[row.symbol] = row.id;
        nextTradeNow[row.symbol] = Boolean(mergedRow.trade_now_active);
      }
      setSetupsBySymbol(nextBySymbol);
      setSetupIdsBySymbol(nextIds);
      setTradeNowBySymbol((prev) => ({ ...prev, ...nextTradeNow }));
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, selectedConnectionId, supabase]);

  useEffect(() => {
    if (!selectedConnectionId) return;
    const liveAvailable = [...new Set(liveQuoteSymbols.filter(Boolean))];
    const streamAvailable = [...new Set((liveSymbols ?? []).filter(Boolean))];
    const dbAvailable = [...new Set(symbols.map((row) => row.symbol).filter(Boolean))];
    const fallbackAvailable = !isAuthenticated ? SUBSCRIBED_DEFAULT_SYMBOLS : dbAvailable;
    const preferredAvailable = liveAvailable.length > 0 ? liveAvailable : streamAvailable.length > 0 ? streamAvailable : fallbackAvailable;
    const available = [...new Set([...liveAvailable, ...streamAvailable, ...fallbackAvailable])];
    if (!available.length) return;
    const resolved = resolveLiveSymbolMatch(selectedSymbol || undefined, available);
    if (!selectedSymbol || !available.includes(selectedSymbol)) {
      setSelectedSymbol(resolved && available.includes(resolved) ? resolved : (preferredAvailable[0] ?? available[0]));
    } else if (resolved && resolved !== selectedSymbol && available.includes(resolved)) {
      setSelectedSymbol(resolved);
    }
  }, [isAuthenticated, selectedConnectionId, symbols, liveSymbols, liveQuoteSymbols, selectedSymbol]);

  useEffect(() => {
    if (!selectedSymbol) return;
    const setup = setupsBySymbol[selectedSymbol];
    if (setup) {
      setSide(setup.side);
      setPivot(String(setup.pivot ?? setup.entry_price ?? ""));
      setTp1(setup.tp1 != null ? String(setup.tp1) : "");
      setTp2(setup.tp2 != null ? String(setup.tp2) : "");
      setAtrZonePct(Number(setup.atr_zone_pct ?? setup.zone_percent) || getZoneDefault(selectedSymbol));
      setSlPadMult(Number(setup.sl_pad_mult) || 0.2);
      setUseAutoRR(false);
      setAutoRR1(1.0);
      setAutoRR2(2.0);
      setAiText("");
      setAiSensitivity(Number(setup.ai_sensitivity ?? 5));
      setActiveSetupState((setup.state as SetupState | undefined) ?? null);
      return;
    }

    const draft = loadDraft(selectedSymbol);
    setSide(draft.side ?? "buy");
    setPivot(draft.entryPrice ?? "");
    setTp1("");
    setTp2("");
    setAtrZonePct(typeof draft.zonePercent === "number" ? draft.zonePercent : getZoneDefault(selectedSymbol));
    setSlPadMult(0.2);
    setAiSensitivity(typeof draft.aiSensitivity === "number" ? draft.aiSensitivity : 5);
    setActiveSetupState(null);
  }, [selectedSymbol, setupsBySymbol]);

  useEffect(() => {
    if (!selectedSymbol) return;
    if (pivot) return;
    if (!livePrice) return;
    const setup = setupsBySymbol[selectedSymbol];
    if (setup) return;
    const draft = loadDraft(selectedSymbol);
    if (draft.entryPrice) return;
    setPivot(String(livePrice.bid));
  }, [selectedSymbol, pivot, livePrice, setupsBySymbol]);

  useEffect(() => {
    if (!selectedSymbol) return;
    saveDraft(selectedSymbol, {
      entryPrice: pivot,
      zonePercent: atrZonePct,
      side,
      aiSensitivity,
    });
  }, [selectedSymbol, pivot, atrZonePct, side, aiSensitivity]);


  useEffect(() => {
    if (!selectedConnectionId || !selectedSymbol) {
      setPendingFeedSymbol(null);
      return;
    }
    setPendingFeedSymbol(selectedSymbol);
    const timeout = window.setTimeout(() => {
      setPendingFeedSymbol((current) => (current === selectedSymbol ? null : current));
    }, 6_000);
    return () => window.clearTimeout(timeout);
  }, [selectedConnectionId, selectedSymbol]);

  useEffect(() => {
    if (!pendingFeedSymbol || pendingFeedSymbol !== selectedSymbol) return;
    const hasResolvedLiveQuote = Boolean(resolvedSelectedSymbol && prices[resolvedSelectedSymbol]);
    const freshQuoteReady = Boolean(
      livePrice
      && livePrice.ts_ms
      && (Date.now() - livePrice.ts_ms) <= 15_000
    );
    if (!freshQuoteReady && !hasResolvedLiveQuote) return;
    setPendingFeedSymbol(null);
  }, [livePrice, pendingFeedSymbol, prices, resolvedSelectedSymbol, selectedSymbol]);
  useEffect(() => {
    if (!selectedConnectionId || !selectedSymbol) {
      setSymbolTradeSpec(null);
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const url = `/api/symbol-spec?symbol=${encodeURIComponent(selectedSymbol)}&conn_id=${encodeURIComponent(selectedConnectionId)}`;
        const resp = await fetch(url, { cache: "no-store" });
        const data = (await resp.json()) as SymbolTradeSpec;
        if (cancelled) return;
        if (!resp.ok || data.error) {
          setSymbolTradeSpec(null);
          return;
        }
        const resolvedSymbol = typeof data.resolved_symbol === "string" ? data.resolved_symbol : null;
        if (resolvedSymbol && resolvedSymbol !== selectedSymbol) {
          setSelectedSymbol((current) => (current === selectedSymbol ? resolvedSymbol : current));
        }
        setSymbolTradeSpec(data);
      } catch {
        if (!cancelled) {
          setSymbolTradeSpec(null);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [selectedConnectionId, selectedSymbol]);

  useEffect(() => {
    if (targetSuggestion == null || !Number.isFinite(targetSuggestion) || targetSuggestion <= 0) return;
    setTpValue((prev) => {
      if (typeof prev === "number" && Math.abs(prev - targetSuggestion) < 1e-9) {
        return prev;
      }
      return targetSuggestion;
    });
  }, [targetSuggestion]);

  useEffect(() => {
    if (stopMode !== "ai_dynamic") return;
    if (!selectedConnectionId || !selectedSymbol) return;

    let cancelled = false;
    setDynamicStopLoading(true);

    const run = async () => {
      try {
        const tf = getSelectedSetupTimeframe();
        const url = `/api/candles?symbol=${encodeURIComponent(selectedSymbol)}&tf=${encodeURIComponent(tf)}&count=300&conn_id=${encodeURIComponent(selectedConnectionId)}`;
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) {
          throw new Error(`Candle fetch failed: ${resp.status}`);
        }
        const data = (await resp.json()) as { bars?: StructureBar[] };
        const bars = Array.isArray(data.bars) ? data.bars : [];
        const derived = deriveDynamicStop({
          bars,
          side,
          aiSensitivity,
          priceIncrement: getPriceIncrement(selectedSymbol),
        });

        if (cancelled) return;

        if (!derived.analysis || derived.stop == null) {
          setDynamicStopState({
            analysis: derived.analysis,
            stop: null,
            referenceLevel: derived.referenceLevel,
            message: `Not enough confirmed structure data for AI Dynamic SL at pivot window ${pivotWindow}.`,
          });
          return;
        }

        const dec = getDecimals(selectedSymbol);
        const nextStop = Number(derived.stop.toFixed(dec));
        setDynamicStopState({
          analysis: derived.analysis,
          stop: nextStop,
          referenceLevel: derived.referenceLevel,
          message: `AI Dynamic SL is anchored ${side === "buy" ? "just below" : "just above"} the ${side === "buy" ? "confirmed swing low" : "confirmed swing high"} from the active structure read using AI sensitivity ${aiSensitivity} (pivot window ${pivotWindow}).`,
        });
        setSlValue(nextStop);

        if (validEntry) {
          const slDistance = Math.abs(parsedEntry - nextStop);
          if (slDistance > 0) {
            const nextTp = side === "buy"
              ? parsedEntry + slDistance * riskRewardRatio
              : parsedEntry - slDistance * riskRewardRatio;
            setTpValue(Number(nextTp.toFixed(dec)));
          }
        }
      } catch (err) {
        if (cancelled) return;
        setDynamicStopState({
          analysis: null,
          stop: null,
          referenceLevel: null,
          message: err instanceof Error ? err.message : "Failed to derive AI dynamic stop.",
        });
      } finally {
        if (!cancelled) {
          setDynamicStopLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [aiSensitivity, pivotWindow, riskRewardRatio, selectedConnectionId, selectedSymbol, side, stopMode, validEntry, parsedEntry]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!selectedConnectionId) return;
    const channel = supabase
      .channel(`terminal-live-${selectedConnectionId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trade_jobs", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const inserted = payload.new as TradeJobRow;
            setRecentJobs((prev) => [inserted, ...prev].slice(0, 30));
            if (typeof inserted.idempotency_key === "string" && inserted.idempotency_key.startsWith("trade_now:")) {
              const msg = `AI system triggered ${inserted.symbol} — the risk-based MT5 order was queued.`;
              setTradeNowResult({ ok: true, msg });
              toast.success(msg);
            }
          }
          if (payload.eventType === "UPDATE") {
            setRecentJobs((prev) => prev.map((row) => (row.id === payload.new.id ? { ...row, ...(payload.new as TradeJobRow) } : row)));
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ea_commands", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const inserted = payload.new as EaCommandRow;
            setRecentCommands((prev) => [inserted, ...prev].slice(0, 30));
          }
          if (payload.eventType === "UPDATE") {
            setRecentCommands((prev) => prev.map((row) => (row.id === payload.new.id ? { ...row, ...(payload.new as EaCommandRow) } : row)));
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ea_command_acks", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const inserted = payload.new as EaCommandAckRow;
            setRecentCommandAcks((prev) => [inserted, ...prev].slice(0, 30));
            if (inserted.status === "rejected") {
              const ackPayload = (inserted.ack_payload_json ?? {}) as Record<string, unknown>;
              const reason = typeof ackPayload.reason === "string" ? ackPayload.reason : "The EA rejected the command.";
              toast.error(reason);
            }
          }
          if (payload.eventType === "UPDATE") {
            setRecentCommandAcks((prev) => prev.map((row) => (row.id === payload.new.id ? { ...row, ...(payload.new as EaCommandAckRow) } : row)));
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trading_setups", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          const row = payload.new as Partial<SetupRow> & { id?: string; symbol?: string; trade_now_active?: boolean; state?: string };
          if (!row?.symbol || !row.id) return;
          setSetupsBySymbol((prev) => ({ ...prev, [row.symbol!]: { ...(prev[row.symbol!] ?? { symbol: row.symbol!, id: row.id } as SetupRow), ...(row as SetupRow) } }));
          setSetupIdsBySymbol((prev) => ({ ...prev, [row.symbol!]: row.id! }));
          if (typeof row.trade_now_active === "boolean") {
            setTradeNowBySymbol((prev) => ({ ...prev, [row.symbol!]: row.trade_now_active! }));
          }
          if (row.symbol === selectedSymbol && row.state) {
            setActiveSetupState(row.state as SetupState);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "mt5_runtime_events", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          const event = payload.new as RuntimeEventRow;
          const details = event.details ?? null;
          if (details?.event_kind !== "trade_now_rejected" || !details.symbol) return;
          const reason = typeof details.reason === "string" && details.reason.trim()
            ? details.reason.trim()
            : "AI system conditions were no longer valid for execution.";
          const msg = `AI system trigger skipped for ${details.symbol} — ${reason}`;
          setTradeNowResult({ ok: false, msg });
          toast.error(msg);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ea_runtime_events", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          const event = payload.new as EaRuntimeEventRow;
          setRecentEaEvents((prev) => [event, ...prev].slice(0, 30));
          const eventPayload = (event.payload ?? {}) as Record<string, unknown>;
          const reason = typeof eventPayload.reason === "string" && eventPayload.reason.trim()
            ? eventPayload.reason.trim()
            : "AI system conditions were no longer valid for execution.";
          const symbol = typeof eventPayload.symbol === "string" ? eventPayload.symbol : null;

          if (event.event_type === "trade_now_rejected" && symbol) {
            const msg = `AI system trigger skipped for ${symbol} — ${reason}`;
            setTradeNowResult({ ok: false, msg });
            toast.error(msg);
          }

          if (event.event_type === "command_processed") {
            const status = typeof eventPayload.status === "string" ? eventPayload.status : "processed";
            const message = symbol
              ? `${symbol} command ${status}${reason ? ` — ${reason}` : ""}`
              : `EA command ${status}${reason ? ` — ${reason}` : ""}`;
            if (status === "rejected") toast.error(message);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ea_live_state", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setEaLiveState(null);
            return;
          }
          setEaLiveState(payload.new as EaLiveStateRow);
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mt5_worker_heartbeats", filter: `connection_id=eq.${selectedConnectionId}` },
        (payload) => setAccountHeartbeat(payload.new as HeartbeatRow)
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isAuthenticated, selectedConnectionId, selectedSymbol, supabase]);

  function promptAuthentication(intent: string) {
    setAuthPromptIntent(intent);
    setAuthPromptOpen(true);
  }

  function requireAuthenticated(intent: string) {
    if (isAuthenticated) return true;
    promptAuthentication(intent);
    return false;
  }

  async function handleMonitorSetup() {
    if (!selectedConnectionId || !selectedSymbol || !validEntry) return;
    if (!requireAuthenticated("save this monitored setup")) return;
    setSetupSaving(true);
    setSetupResult(null);
    try {
      const newId = await saveTrackedSetup({
        connection_id: selectedConnectionId,
        symbol: selectedSymbol,
        side,
        entry_price: parsedEntry,
        zone_percent: atrZonePct,
        timeframe: getSelectedSetupTimeframe(),
        ai_sensitivity: aiSensitivity,
        setup_id: setupIdsBySymbol[selectedSymbol] ?? null,
        pivot: parsedEntry,
        tp1: useAutoRR ? null : (parseFloat(tp1) || null),
        tp2: useAutoRR ? null : (parseFloat(tp2) || null),
        atr_zone_pct: atrZonePct,
        sl_pad_mult: slPadMult,
        use_auto_rr: useAutoRR,
        auto_rr1: useAutoRR ? autoRR1 : null,
        auto_rr2: useAutoRR ? autoRR2 : null,
      });

      const nextSetup: SetupRow = {
        id: newId,
        symbol: selectedSymbol,
        side,
        entry_price: parsedEntry,
        zone_percent: atrZonePct,
        pivot: parsedEntry,
        tp1: parseFloat(tp1) || null,
        tp2: parseFloat(tp2) || null,
        atr_zone_pct: atrZonePct,
        sl_pad_mult: slPadMult,
        timeframe: getSelectedSetupTimeframe(),
        ai_sensitivity: aiSensitivity,
        state: "IDLE",
      };
      setSetupIdsBySymbol((prev) => ({ ...prev, [selectedSymbol]: newId }));
      setSetupsBySymbol((prev) => ({ ...prev, [selectedSymbol]: nextSetup }));
      setActiveSetupState(null);
      setSetupResult({ ok: true, msg: `MONITORING ACTIVE — ${selectedSymbol} is now under state + structure tracking.` });
      toast.success(`Monitoring ${selectedSymbol}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save setup";
      setSetupResult({ ok: false, msg });
      toast.error(msg);
    } finally {
      setSetupSaving(false);
    }
  }

  async function handleTradeNow() {
    if (!selectedConnectionId || !selectedSymbol || !validEntry) return;
    if (!requireAuthenticated("arm Trade Now")) return;
    if (!termsAccepted) {
      setTermsOpen(true);
      return;
    }
    setTradeNowSaving(true);
    setTradeNowResult(null);
    try {
      const tradePlanNotes = buildTradeNowPlan({
        stopMode,
        stopLoss: validStopLoss ? Number(slValue) : null,
        takeProfit: validTakeProfit ? Number(effectiveTakeProfit) : null,
        riskMode,
        riskPercent,
        riskUsd,
        riskRewardRatio,
        armedEntryPrice: parsedEntry,
      });
      const outcome = await activateTradeNow({
        connection_id: selectedConnectionId,
        symbol: selectedSymbol,
        side,
        entry_price: parsedEntry,
        zone_percent: atrZonePct,
        timeframe: getSelectedSetupTimeframe(),
        ai_sensitivity: aiSensitivity,
        trade_plan_notes: tradePlanNotes,
        setup_id: setupIdsBySymbol[selectedSymbol] ?? null,
        pivot: parsedEntry,
        tp1: useAutoRR ? null : (parseFloat(tp1) || null),
        tp2: useAutoRR ? null : (parseFloat(tp2) || null),
        atr_zone_pct: atrZonePct,
        sl_pad_mult: slPadMult,
        use_auto_rr: useAutoRR,
        auto_rr1: useAutoRR ? autoRR1 : null,
        auto_rr2: useAutoRR ? autoRR2 : null,
      });
      const setupId = outcome.setupId;
      setSetupIdsBySymbol((prev) => ({ ...prev, [selectedSymbol]: setupId }));
      setTradeNowBySymbol((prev) => ({ ...prev, [selectedSymbol]: true }));
      setTradeNowResult({ ok: true, msg: "ARMED — waiting for STALKING + matching AI system trigger." });
      toast.success(`Trade Now armed for ${selectedSymbol}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to arm Trade Now";
      setTradeNowResult({ ok: false, msg });
      toast.error(msg);
    } finally {
      setTradeNowSaving(false);
    }
  }

  function handlePlaceTrade() {
    if (!selectedConnectionId || !selectedSymbol) return;
    if (!requireAuthenticated("queue a trade")) return;
    if (!termsAccepted) {
      setTermsOpen(true);
      return;
    }
    if (aiManagedExecution) {
      const msg = "AI Dynamic mode finalizes SL, TP, and lot size through the AI trigger. Switch Stop Mode to Manual for fixed-value execution.";
      setManualResult({ ok: false, msg });
      toast.error(msg);
      return;
    }
    if (!Number.isFinite(lotSuggestion) || lotSuggestion <= 0) {
      const msg = "Manual lot sizing is invalid for the current entry, stop, and risk inputs. Adjust the stop or risk settings and try again.";
      setManualResult({ ok: false, msg });
      toast.error(msg);
      return;
    }

    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set("connection_id", selectedConnectionId);
        fd.set("symbol", selectedSymbol);
        fd.set("side", side);
        fd.set("volume", String(Number(lotSuggestion.toFixed(2))));
        fd.set("sl", slValue ? String(slValue) : "");
        fd.set("tp", effectiveTakeProfit ? String(effectiveTakeProfit) : "");
        // Pending order signalling via comment prefix
        const pp = parseFloat(pendingPrice);
        if (orderType === "limit" && !isNaN(pp) && pp > 0) fd.set("comment", `__limit__:${pp}`);
        else if (orderType === "stop"  && !isNaN(pp) && pp > 0) fd.set("comment", `__stop__:${pp}`);
        await placeManualTrade(fd);
        const msg = `Trade queued for ${selectedSymbol}. Check runtime/execution status below.`;
        setManualResult({ ok: true, msg });
        toast.success(msg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to queue trade";
        setManualResult({ ok: false, msg });
        toast.error(msg);
      }
    });
  }

  const currentSetupId = selectedSymbol ? setupIdsBySymbol[selectedSymbol] : undefined;
  const tradeNowArmed = selectedSymbol ? Boolean(tradeNowBySymbol[selectedSymbol]) : false;
  const armedSetupRows = useMemo(() => {
    return Object.values(setupsBySymbol)
      .filter((setup) => Boolean(setup?.symbol) && Boolean(tradeNowBySymbol[setup.symbol] || setup.trade_now_active))
      .map((setup) => {
        const setupZone = calcZone(setup.pivot ?? setup.entry_price ?? 0, Number(setup.atr_zone_pct ?? setup.zone_percent) || getZoneDefault(setup.symbol));
        const setupPrice = prices[setup.symbol];
        const displayState = (setup.state as SetupState | undefined) ?? null;
        return {
          ...setup,
          displayState,
          zone: setupZone,
          livePrice: setupPrice,
        };
      })
      .sort((a, b) => {
        if (a.symbol === selectedSymbol) return -1;
        if (b.symbol === selectedSymbol) return 1;
        return a.symbol.localeCompare(b.symbol);
      });
  }, [prices, selectedSymbol, setupsBySymbol, tradeNowBySymbol]);
  const runtimeSetupState = hudStatusToSetupState(eaLiveState?.hud_status);
  const baseSetupState = runtimeSetupState ?? activeSetupState;
  const displaySetupState = deriveDisplaySetupState({ runtimeState: baseSetupState, zone, price: livePrice });
  const setupStateDerivedFromQuote = Boolean(
    displaySetupState === "STALKING"
    && baseSetupState !== "STALKING"
    && baseSetupState !== "PURGATORY"
    && baseSetupState !== "DEAD"
  );
  const stateCfg = displaySetupState ? SETUP_STATE_CFG[displaySetupState] : null;
  const executionBlocker = useMemo(() => {
    if (!termsAccepted) return "Accept the current terminal terms before queueing live MT5 execution.";
    if (!(riskAmount > 0)) return "Risk amount must be greater than zero.";
    if (!aiManagedExecution && lotSizing.minLotExceedsRisk) {
      return `Minimum broker lot ${lotSizing.volumeMin.toFixed(2)} risks ${fmtCurrency(lotSizing.actualRisk)}, above your selected risk ${fmtCurrency(riskAmount)}.`;
    }
    if (maxTradesPerDay > 0 && todaysTradeCount >= maxTradesPerDay) {
      return `Daily trade limit reached: ${todaysTradeCount}/${maxTradesPerDay}.`;
    }
    if (maxPositionSizeLots > 0 && lotSuggestion > maxPositionSizeLots) {
      return `Lot size ${lotSuggestion.toFixed(2)} exceeds your max position size of ${maxPositionSizeLots} lots.`;
    }

    const floatingPnl = openPositions.reduce((sum, position) => sum + position.profit + position.swap, 0);
    if (dailyLossLimitUsd > 0 && floatingPnl < -dailyLossLimitUsd) {
      return `Daily loss limit of $${dailyLossLimitUsd} reached (floating: ${fmtCurrency(floatingPnl)}).`;
    }
    if (dailyProfitTargetUsd > 0 && floatingPnl >= dailyProfitTargetUsd) {
      return `Daily profit target of $${dailyProfitTargetUsd} reached - trading locked for today.`;
    }
    if (maxDrawdownPercent > 0 && accountBalance > 0) {
      const drawdown = ((accountBalance - accountEquity) / accountBalance) * 100;
      if (drawdown >= maxDrawdownPercent) {
        return `Max drawdown of ${maxDrawdownPercent}% reached (current: ${drawdown.toFixed(1)}%).`;
      }
    }

    return null;
  }, [
    accountBalance,
    accountEquity,
    aiManagedExecution,
    dailyLossLimitUsd,
    dailyProfitTargetUsd,
    lotSizing.actualRisk,
    lotSizing.minLotExceedsRisk,
    lotSizing.volumeMin,
    lotSuggestion,
    maxDrawdownPercent,
    maxPositionSizeLots,
    maxTradesPerDay,
    openPositions,
    riskAmount,
    termsAccepted,
    todaysTradeCount,
  ]);
  const validStopLoss = typeof slValue === "number" && Number.isFinite(slValue) && slValue > 0 && stopDistance > 0;
  const validTakeProfit = typeof effectiveTakeProfit === "number" && Number.isFinite(effectiveTakeProfit) && effectiveTakeProfit > 0;
  const aiStructureReady = dynamicStopState.stop != null;
  const liveLotsDisplay = aiManagedExecution ? "AI" : (Number.isFinite(lotSuggestion) && lotSuggestion > 0 ? lotSuggestion.toFixed(2) : "0.01");
  const liveSlDisplay = aiManagedExecution ? "AI" : (slValue ?? "");
  const liveTpDisplay = aiManagedExecution ? "AI" : (effectiveTakeProfit ?? "");
  const tradeNowPrereqMsg = !currentSetupId
    ? isAuthenticated
      ? "Press Monitor Zone first so the runtime starts tracking state."
      : "Sign in first, then monitor the setup or connect your MT5 account before arming Trade Now."
    : displaySetupState === "DEAD"
      ? "Runtime currently reports DEAD. You can still arm the command, but the EA remains authoritative and may reject execution until the setup is refreshed."
    : aiManagedExecution
      ? !aiStructureReady
        ? "AI is still reading structure. SL, TP, and lot size will be finalized by AI when the trigger happens."
        : executionGuardPreview
          ? `Ready to arm. Server and EA will validate live guardrails at queue time: ${executionGuardPreview}`
          : "Trade Now is ready. AI will finalize SL, TP, and lot size at trigger time."
      : !validStopLoss
        ? "Set a valid stop loss before arming Trade Now."
        : !validTakeProfit
          ? "Risk-reward target is not ready yet. TP is derived automatically from your RR setting once entry and SL are valid."
          : executionGuardPreview
            ? `Ready to queue. Server and EA will validate live guardrails at queue time: ${executionGuardPreview}`
            : "Trade Now is ready to arm.";
  const tradeNowCanArm = Boolean(
    currentSetupId
    && selectedConnectionId
    && validEntry
    && (aiManagedExecution ? aiStructureReady : validStopLoss)
    && (aiManagedExecution ? true : validTakeProfit)
    && !tradeNowArmed
    && !tradeNowSaving
    && !setupSaving
  );
  const tradeNowButtonEnabled = isAuthenticated
    ? tradeNowCanArm
    : Boolean(selectedConnectionId && selectedSymbol);
  const dbSymbols = [...new Set(symbols.map((row) => row.symbol).filter(Boolean))];
  const liveSelectableSymbols = [...new Set(liveQuoteSymbols.filter(Boolean))];
  const streamSelectableSymbols = [...new Set((liveSymbols ?? []).filter(Boolean))];
  const fallbackSelectableSymbols = isAuthenticated ? dbSymbols : SUBSCRIBED_DEFAULT_SYMBOLS;
  const availableSymbols = [...new Set([
    ...liveSelectableSymbols,
    ...streamSelectableSymbols,
    ...fallbackSelectableSymbols,
  ])];
  const hasLiveQuoteForSelected = Boolean(
    (resolvedSelectedSymbol && prices[resolvedSelectedSymbol])
    || (selectedSymbol && prices[selectedSymbol])
  );
  const quoteSymbol = activeSymbol;
  const quoteDigits = getDecimals(quoteSymbol);
  const quoteBid = livePrice ? livePrice.bid.toFixed(quoteDigits) : "—";
  const quoteAsk = livePrice ? livePrice.ask.toFixed(quoteDigits) : "—";
  const selectedPriceAgeMs = livePrice?.ts_ms ? Date.now() - livePrice.ts_ms : Number.POSITIVE_INFINITY;
  const hasFreshSelectedQuote = Boolean(livePrice && selectedPriceAgeMs <= SELECTED_QUOTE_FRESH_MS);
  const selectedQuoteAgeLabel = Number.isFinite(selectedPriceAgeMs)
    ? selectedPriceAgeMs >= 10_000
      ? `${(selectedPriceAgeMs / 1000).toFixed(0)}s old`
      : `${(selectedPriceAgeMs / 1000).toFixed(1)}s old`
    : null;
  const isPairSwitchLoading = Boolean(
    selectedConnectionId
    && selectedSymbol
    && pendingFeedSymbol === selectedSymbol
    && !hasLiveQuoteForSelected
  );
  const feedStatus = transportMode === "ws"
    ? {
        dot: "bg-emerald-400 animate-pulse",
        label: "WebSocket live",
        tone: "text-emerald-300",
        detail: hasFreshSelectedQuote ? "Primary stream active" : "Transport live, quote refreshing",
      }
    : transportMode === "polling"
      ? {
          dot: "bg-red-400 animate-pulse",
          label: "Polling fallback",
          tone: "text-red-300",
          detail: "Recovering live feed",
        }
      : {
          dot: "bg-yellow-500 animate-pulse",
          label: "Connecting",
          tone: "text-yellow-300",
          detail: "Waiting for live feed",
        };
  // Fallback symbol list while SSE connects — same as ManualTradeCard SUBSCRIBED list
  const rawTabSymbols = liveSelectableSymbols.length > 0 ? liveSelectableSymbols : availableSymbols.length > 0 ? availableSymbols : SUBSCRIBED_DEFAULT_SYMBOLS;
  const tabSymbols = [
    ...(displaySymbol ? [displaySymbol] : []),
    ...rawTabSymbols,
  ].filter((sym, index, arr) => Boolean(sym) && arr.indexOf(sym) === index);
  const symbolTabIndex = Math.max(0, tabSymbols.indexOf(displaySymbol));
  const symbolMetadata = useMemo(() => {
    const bySymbol = new Map<string, SymbolRow>();
    for (const row of symbols) {
      if (!row.symbol) continue;
      bySymbol.set(row.symbol, row);
    }
    return bySymbol;
  }, [symbols]);
  const symbolChooserOptions = useMemo(() => {
    const uniqueSymbols = [...new Set([...availableSymbols, ...dbSymbols, ...tabSymbols])]
      .filter((sym): sym is string => Boolean(sym) && sym !== displaySymbol);

    return uniqueSymbols.map((sym) => {
      const meta = symbolMetadata.get(sym);
      const live = prices[sym];
      return {
        symbol: sym,
        description: meta?.description?.trim() || null,
        category: meta?.category?.trim() || null,
        bid: live?.bid ?? null,
        hasLive: Boolean(live),
      };
    });
  }, [availableSymbols, dbSymbols, displaySymbol, prices, symbolMetadata, tabSymbols]);
  const filteredSymbolChooserOptions = useMemo(() => {
    const query = symbolChooserQuery.trim().toLowerCase();
    if (!query) return symbolChooserOptions;

    return symbolChooserOptions.filter((option) => {
      const haystack = [option.symbol, option.description ?? "", option.category ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [symbolChooserOptions, symbolChooserQuery]);

  const stepSelectedSymbol = (direction: -1 | 1) => {
    if (!tabSymbols.length) return;
    const nextIndex = (symbolTabIndex + direction + tabSymbols.length) % tabSymbols.length;
    setSelectedSymbol(tabSymbols[nextIndex]);
  };

  const chooseSymbolFromModal = (symbol: string) => {
    setSelectedSymbol(symbol);
    setSymbolChooserOpen(false);
    setSymbolChooserQuery("");
  };

  function renderAITrading() {
    return (
      <div className="grid min-h-[calc(100vh-76px)] grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)_340px] lg:gap-0">
        <aside className="order-2 rounded-xl border border-[#1f1f1f] bg-[#101010] lg:order-none lg:rounded-none lg:border-y-0 lg:border-l-0 lg:border-r lg:border-[#1a1a1a]">
          <div className="space-y-6 p-4 lg:p-5">
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Network className="size-4" /> Terminal Link
              </div>
              <div className="space-y-2 rounded-xl border border-[#202020] bg-[#151515] p-3">
                <Label className="text-[11px] uppercase tracking-wide text-gray-500">Connection</Label>
                <select
                  value={selectedConnectionId}
                  onChange={(e) => setSelectedConnectionId(e.target.value)}
                  disabled={!isAuthenticated}
                  className="h-10 w-full rounded-lg border border-[#2b2b2b] bg-[#0f0f0f] px-3 text-sm text-white outline-none focus:border-blue-500/50"
                >
                  {connections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.account_login} · {conn.broker_server}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-between text-[11px] text-gray-500">
                  <span>Runtime</span>
                  <StatusBadge status={accountHeartbeat?.status ?? selectedConnection?.status} />
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Target className="size-4" /> Entry + Zone Setup
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-3">
                <div>
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">Symbol</Label>
                  <select
                    value={selectedSymbol}
                    onChange={(e) => setSelectedSymbol(e.target.value)}
                    className="h-10 w-full rounded-lg border border-[#2b2b2b] bg-[#0f0f0f] px-3 text-sm text-white outline-none focus:border-blue-500/50"
                  >
                    {availableSymbols.map((sym) => (
                      <option key={sym} value={sym}>{sym}</option>
                    ))}
                  </select>
                </div>

                {selectedSymbol && !hasLiveQuoteForSelected && liveSelectableSymbols.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    No live MT5 quote is available for {selectedSymbol} on this connection. Switch to a live symbol to see streaming prices.
                  </div>
                )}
                <div className="rounded-lg border border-[#252525] bg-[#101010] px-3 py-2 text-[11px] text-gray-500">
                  Primary symbol selector for chart, pricing, and execution.
                </div>

                <div>
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">Pivot Level</Label>
                  <Input
                    type="number"
                    step="any"
                    value={pivot}
                    onChange={(e) => setPivot(e.target.value)}
                    placeholder={livePrice ? String(livePrice.bid) : "0.00000"}
                    className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white"
                  />
                </div>

                {!useAutoRR && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">TP1</Label>
                    <Input type="number" step="any" value={tp1} onChange={(e) => setTp1(e.target.value)} placeholder="0.00000" className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">TP2</Label>
                    <Input type="number" step="any" value={tp2} onChange={(e) => setTp2(e.target.value)} placeholder="0.00000" className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">ATR Zone %</Label>
                    <Input type="number" step="0.1" value={atrZonePct} onChange={(e) => setAtrZonePct(parseFloat(e.target.value) || 0)} className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">SL Pad ×</Label>
                    <Input type="number" step="0.1" value={slPadMult} onChange={(e) => setSlPadMult(parseFloat(e.target.value) || 0)} className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                </div>

                {/* Auto R:R toggle */}
                <label className="flex items-center justify-between rounded-lg border border-[#232323] bg-[#111] px-3 py-2 text-xs text-gray-300 cursor-pointer">
                  <span>Auto R:R (hide manual TP)</span>
                  <input type="checkbox" checked={useAutoRR} onChange={(e) => setUseAutoRR(e.target.checked)} className="accent-purple-500" />
                </label>

                {useAutoRR && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">RR1 ×</Label>
                      <Input type="number" step="0.1" min="0.1" value={autoRR1} onChange={(e) => setAutoRR1(parseFloat(e.target.value) || 1)} className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                    </div>
                    <div>
                      <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">RR2 ×</Label>
                      <Input type="number" step="0.1" min="0.1" value={autoRR2} onChange={(e) => setAutoRR2(parseFloat(e.target.value) || 2)} className="h-10 border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                    </div>
                  </div>
                )}

                {/* AI Brain */}
                <details className="rounded-lg border border-[#232323] bg-[#111]">
                  <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wide text-gray-500 select-none">AI Brain — paste analysis</summary>
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    <textarea
                      rows={4}
                      value={aiText}
                      onChange={(e) => setAiText(e.target.value)}
                      placeholder={"BIAS: Long\nPIVOT: 2650.5\nTP1: 2680\nTP2: 2720"}
                      className="w-full rounded border border-[#2b2b2b] bg-[#0c0c0c] px-2 py-1.5 text-[11px] font-mono text-gray-200 focus:outline-none focus:border-blue-500/40 resize-none"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 w-full bg-purple-600/80 text-white hover:bg-purple-500 text-[11px]"
                      onClick={() => {
                        const text = aiText;
                        const extract = (labels: string[]): number | null => {
                          for (const lbl of labels) {
                            const m = new RegExp(`${lbl}[:\\s]+([\\d.]+)`, "i").exec(text);
                            if (m) return parseFloat(m[1]);
                          }
                          return null;
                        };
                        const biasM = /BIAS[:\s]+(Long|Short|Buy|Sell|Neutral)/i.exec(text);
                        if (biasM) {
                          const b = biasM[1].toLowerCase();
                          if (b === "long" || b === "buy") setSide("buy");
                          else if (b === "short" || b === "sell") setSide("sell");
                        }
                        const pv = extract(["PIVOT", "ENTRY"]);
                        if (pv) setPivot(String(pv));
                        const t1 = extract(["TP1", "TARGET 1", "TARGET1"]);
                        if (t1) setTp1(String(t1));
                        const t2 = extract(["TP2", "TARGET 2", "TARGET2"]);
                        if (t2) setTp2(String(t2));
                      }}
                    >
                      Parse &amp; Apply
                    </Button>
                  </div>
                </details>

                {/* EA Visuals */}
                <details className="rounded-lg border border-[#232323] bg-[#111]">
                  <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wide text-gray-500 select-none">EA Visuals</summary>
                  <div className="px-3 pb-3 pt-2 space-y-3">
                    <label className="flex items-center justify-between text-xs text-gray-300 cursor-pointer">
                      <span>Show SMC Structure lines</span>
                      <input type="checkbox" checked={showStruct} onChange={(e) => setShowStruct(e.target.checked)} className="accent-blue-500" />
                    </label>
                    <div>
                      <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">SMC Lookback (candles)</Label>
                      <Input type="number" step="50" min="50" max="5000" value={smcLookback} onChange={(e) => setSmcLookback(parseInt(e.target.value) || 400)} className="h-9 border-[#2b2b2b] bg-[#0c0c0c] text-white" />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={visualsSaving || !selectedConnectionId}
                      className="h-8 w-full bg-blue-700/80 text-white hover:bg-blue-600 text-[11px] disabled:opacity-40"
                      onClick={async () => {
                        if (!selectedConnectionId) return;
                        setVisualsSaving(true);
                        try {
                          await patchEaVisuals({ connectionId: selectedConnectionId, showStruct, smcLookback });
                          toast.success("EA visuals saved");
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed to save visuals");
                        } finally {
                          setVisualsSaving(false);
                        }
                      }}
                    >
                      {visualsSaving ? "Saving…" : "Save to EA"}
                    </Button>
                  </div>
                </details>

                {zone && (
                  <div className="space-y-1 rounded-lg bg-[#0f0f0f] p-3 text-xs">
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Entry Zone</span>
                      <span className="font-mono text-blue-400">{fmtPrice(zone.low, selectedSymbol)} – {fmtPrice(zone.high, selectedSymbol)}</span>
                    </div>
                    {parseFloat(tp1) > 0 && (
                      <div className="flex items-center justify-between text-gray-500">
                        <span>TP1</span>
                        <span className="font-mono text-emerald-400">{fmtPrice(parseFloat(tp1), selectedSymbol)}</span>
                      </div>
                    )}
                    {parseFloat(tp2) > 0 && (
                      <div className="flex items-center justify-between text-gray-500">
                        <span>TP2</span>
                        <span className="font-mono text-emerald-300">{fmtPrice(parseFloat(tp2), selectedSymbol)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-gray-500">
                      <span>Loss Edge</span>
                      <span className="font-mono text-red-400">{fmtPrice(side === "buy" ? zone.low : zone.high, selectedSymbol)}</span>
                    </div>
                  </div>
                )}

                <div className="space-y-2 rounded-lg bg-[#0f0f0f] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">AI Sensitivity</span>
                    <span className="font-semibold text-yellow-300">{aiSensitivity}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={aiSensitivity}
                    onChange={(e) => setAiSensitivity(parseInt(e.target.value, 10))}
                    className="w-full accent-yellow-500"
                  />
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    AI sensitivity maps directly to <span className="text-gray-300">pivot window = {pivotWindow}</span>. Higher values inspect broader structure, which makes AI Dynamic SL anchor farther out on confirmed swings.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
                  <label className="flex items-center justify-between rounded-lg border border-[#232323] bg-[#111] px-3 py-2">
                    <span>Show Entry Zones</span>
                    <input type="checkbox" checked={showEntryZones} onChange={(e) => setShowEntryZones(e.target.checked)} className="accent-blue-500" />
                  </label>
                  <label className="flex items-center justify-between rounded-lg border border-[#232323] bg-[#111] px-3 py-2">
                    <span>Show TP Zones</span>
                    <input type="checkbox" checked={showTPZones} onChange={(e) => setShowTPZones(e.target.checked)} className="accent-blue-500" />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <Button onClick={handleMonitorSetup} disabled={setupSaving || !validEntry || !selectedConnectionId} className="h-10 bg-blue-600 text-white hover:bg-blue-500">
                    {setupSaving ? "Saving…" : currentSetupId ? "Update Monitor" : "Monitor Zone"}
                  </Button>
                </div>

                {setupResult && <InlineMessage ok={setupResult.ok} message={setupResult.msg} />}
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Link2 className="size-4" /> Setup State
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-3">
                <div className="flex flex-wrap gap-2">
                  {(["IDLE", "STALKING", "PURGATORY", "DEAD"] as SetupState[]).map((state) => {
                    const cfg = SETUP_STATE_CFG[state];
                    const active = displaySetupState === state;
                    return (
                      <span key={state} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wider ${active ? cfg.badge : "border-[#2a2a2a] bg-[#111] text-gray-600"}`}>
                        {active ? <span className={`size-1.5 rounded-full ${cfg.dot}`} /> : null}
                        {cfg.label}
                      </span>
                    );
                  })}
                </div>
                <p className="text-xs leading-relaxed text-gray-500">{stateCfg?.desc ?? "Press Monitor Zone to start runtime state tracking for this setup."}</p>
                {setupStateDerivedFromQuote ? (
                  <p className="text-[11px] leading-relaxed text-blue-300">
                    Live quote is already inside the zone. The runtime state badge is being elevated locally while backend state sync catches up.
                  </p>
                ) : null}
                {tradeNowArmed ? (
                  <div className="rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs text-orange-300">
                    Armed one-shot execution: the runtime will queue a risk-based MT5 order on the next matching AI system trigger.
                  </div>
                ) : null}
              </div>
            </section>

            {/* ── Timeframes ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">Timeframes</div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-2">
                <div>
                  <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Engine TF</Label>
                  <select value={engineTf} onChange={(e) => setEngineTf(e.target.value)} className="h-8 w-full rounded border border-[#2b2b2b] bg-[#0f0f0f] px-2 text-xs text-white outline-none">
                    {["M1","M5","M15","M30","H1"].map(tf => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Boss TF</Label>
                    <select value={bossTimeframe} onChange={(e) => setBossTimeframe(e.target.value)} className="h-8 w-full rounded border border-[#2b2b2b] bg-[#0f0f0f] px-2 text-xs text-white outline-none">
                      {["M15","M30","H1","H4","D1"].map(tf => <option key={tf} value={tf}>{tf}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">SL TF</Label>
                    <select value={slTimeframe} onChange={(e) => setSlTimeframe(e.target.value)} className="h-8 w-full rounded border border-[#2b2b2b] bg-[#0f0f0f] px-2 text-xs text-white outline-none">
                      {["M1","M5","M15"].map(tf => <option key={tf} value={tf}>{tf}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">BE TF</Label>
                    <select value={beTimeframe} onChange={(e) => setBeTimeframe(e.target.value)} className="h-8 w-full rounded border border-[#2b2b2b] bg-[#0f0f0f] px-2 text-xs text-white outline-none">
                      {["M5","M10","M15","M30"].map(tf => <option key={tf} value={tf}>{tf}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Trade Management ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">Trade Management</div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Magic ID</Label>
                    <Input type="number" step="1" value={baseMagic} onChange={(e) => setBaseMagic(parseInt(e.target.value, 10) || 9180)} className="h-8 border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white" />
                  </div>
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">TP1 Close %</Label>
                    <Input type="number" step="5" min="10" max="100" value={tp1Pct} onChange={(e) => setTp1Pct(parseFloat(e.target.value) || 75)} className="h-8 border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white" />
                  </div>
                </div>
                <div className="space-y-1.5 pt-1">
                  {([
                    { key: "usePartial", label: "Partial Close (TP1/TP2)", val: usePartial, set: setUsePartial },
                    { key: "useBE", label: "Break-Even after TP1", val: useBE, set: setUseBE },
                    { key: "closeEod", label: "Force Close at EOD", val: closeEod, set: setCloseEod },
                  ] as const).map(({ label, val, set }) => (
                    <label key={label} className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-xs text-gray-300 cursor-pointer">
                      <span>{label}</span>
                      <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} className="accent-blue-500" />
                    </label>
                  ))}
                </div>
                {closeEod && (
                  <div>
                    <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">EOD Time (server)</Label>
                    <Input type="time" value={eodTime} onChange={(e) => setEodTime(e.target.value)} className="h-8 border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white" />
                  </div>
                )}
              </div>
            </section>
          </div>
        </aside>

        <section className="order-1 space-y-4 rounded-xl border border-[#1f1f1f] bg-[#0c0c0c] p-4 lg:order-none lg:rounded-none lg:border-y-0 lg:border-l-0 lg:border-r-0 lg:px-5 lg:py-4">
          <div className="sticky top-0 z-20 -mx-4 space-y-4 border-b border-[#1a1a1a] bg-[#090909]/98 px-4 pb-4 backdrop-blur-sm lg:static lg:mx-0 lg:border-b-0 lg:bg-transparent lg:px-0 lg:pb-0 lg:backdrop-blur-0">
            {!isAuthenticated ? (
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="font-semibold text-white">Guest preview mode</div>
                    <div className="text-xs text-blue-100/80">Live prices and charts are visible without login. Sign in before using Monitor Zone, Trade Now, or trade execution.</div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" onClick={() => router.push("/login?next=%2Fterminal")} className="bg-blue-600 text-white hover:bg-blue-500">Sign In</Button>
                    <Button type="button" variant="outline" onClick={() => router.push("/login?next=%2Fconnections")} className="border-blue-400/30 bg-transparent text-blue-100 hover:bg-blue-500/10">Connect Account</Button>
                  </div>
                </div>
              </div>
            ) : null}
            {/* ── Account / status strip ── */}
            <div className="grid gap-3 xl:grid-cols-[1fr_auto] xl:items-center">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={side === "buy" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}>{side.toUpperCase()}</Badge>
                <StatusBadge status={accountHeartbeat?.status ?? selectedConnection?.status} />
                {tradeNowArmed ? <Badge className="bg-orange-500/15 text-orange-300">ARMED</Badge> : null}
                <span className="text-xs text-gray-500">{selectedConnection ? `${selectedConnection.account_login} · ${selectedConnection.broker_server}` : "No active connection"}</span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="text-right">
                  <div className="text-gray-500">Balance</div>
                  <div className="font-semibold text-white">{fmtCurrency(accountBalance)}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-500">Equity</div>
                  <div className="font-semibold text-emerald-300">{fmtCurrency(accountEquity)}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${feedStatus.dot}`} />
                  <span className={`font-medium ${feedStatus.tone}`}>{feedStatus.label}</span>
                </div>
              </div>
            </div>

            {/* ── Symbol tab bar — identical pattern to strategies page ManualTradeCard ── */}
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => stepSelectedSymbol(-1)}
                disabled={tabSymbols.length <= 1}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-[#242424] bg-[#111] text-gray-300 transition hover:bg-[#181818] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Previous symbol"
              >
                <ChevronLeft className="size-4" />
              </button>

              <div
                className="flex min-w-0 flex-1 overflow-x-auto rounded-lg border border-[#1a1a1a] bg-[#0d0d0d]"
                style={{ scrollbarWidth: "none" }}
              >
                {tabSymbols.map((sym) => {
                  const live   = prices[sym];
                  const isAct  = displaySymbol === sym;
                  const digits = getDecimals(sym);
                  return (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => setSelectedSymbol(sym)}
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

              <button
                type="button"
                onClick={() => setSymbolChooserOpen(true)}
                className="flex h-12 min-w-[118px] shrink-0 items-center gap-2 rounded-lg border border-[#242424] bg-[#111] px-3 text-sm text-gray-200 transition hover:bg-[#181818] hover:text-white"
                aria-label="Choose symbol"
              >
                <Plus className="size-4 text-gray-400" />
                <span className="text-xs font-medium">Choose</span>
              </button>

              <button
                type="button"
                onClick={() => stepSelectedSymbol(1)}
                disabled={tabSymbols.length <= 1}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-[#242424] bg-[#111] text-gray-300 transition hover:bg-[#181818] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Next symbol"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>

            <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-gray-500">Active quote</div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-lg font-semibold text-white">{quoteSymbol}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${side === "buy" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                      {side.toUpperCase()} ready
                    </span>
                    {!hasFreshSelectedQuote ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        Quote stale{selectedQuoteAgeLabel ? ` ${selectedQuoteAgeLabel}` : ""}
                      </span>
                    ) : null}
                    {tradeNowArmed ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                        ARMED setup
                      </span>
                    ) : null}
                  </div>
                  {tradeNowArmed ? (
                    <div className="mt-1 text-[11px] text-orange-300">
                      Waiting for `STALKING` + matching AI trigger.
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2 md:min-w-[280px]">
                  <div className="rounded-lg border border-[#1f3a2f] bg-emerald-500/10 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80">Bid</div>
                    <div className="mt-1 font-mono text-lg font-semibold text-emerald-300">{quoteBid}</div>
                  </div>
                  <div className="rounded-lg border border-[#3a2323] bg-red-500/10 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-red-300/80">Ask</div>
                    <div className="mt-1 font-mono text-lg font-semibold text-red-300">{quoteAsk}</div>
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSide("buy")}
                  className={`h-11 rounded-lg border text-sm font-semibold transition ${side === "buy" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-[#2a2a2a] bg-[#111] text-gray-400 hover:text-white"}`}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setSide("sell")}
                  className={`h-11 rounded-lg border text-sm font-semibold transition ${side === "sell" ? "border-red-500/40 bg-red-500/15 text-red-300" : "border-[#2a2a2a] bg-[#111] text-gray-400 hover:text-white"}`}
                >
                  SELL
                </button>
              </div>
            </div>

            {hydrated && (selectedConnectionId || !isAuthenticated) ? (
              <div className="relative">
                <CandlestickChart
                  symbol={displaySymbol}
                  liveSymbol={liveQuoteSymbol}
                  connId={selectedConnectionId || undefined}
                  entryPrice={showEntryZones && validEntry ? parsedEntry : undefined}
                  entryZoneLow={showEntryZones && zone ? zone.low : undefined}
                  entryZoneHigh={showEntryZones && zone ? zone.high : undefined}
                  sl={showEntryZones && !aiManagedExecution ? slValue : undefined}
                  tp={showTPZones && !aiManagedExecution ? effectiveTakeProfit : undefined}
                  tp1={showTPZones && !useAutoRR && parseFloat(tp1) > 0 ? parseFloat(tp1) : undefined}
                  tp2={showTPZones && !useAutoRR && parseFloat(tp2) > 0 ? parseFloat(tp2) : undefined}
                  invalidation={zone ? (side === "buy" ? zone.low : zone.high) : undefined}
                  prices={prices}
                  forming={forming}
                  lastClose={lastClose}
                  className="w-full"
                />
              </div>
            ) : hydrated ? (
              <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#0c0c0c] px-6 py-10 text-center text-sm text-gray-500">
                Select an active MT5 connection to load live prices and historical candles.
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
            <div className="rounded-xl border border-[#1f1f1f] bg-[#121212] p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Edit3 className="size-4" /> Live Execution Form
              </div>
              {aiManagedExecution ? (
                <div className="mb-3 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
                  AI Dynamic mode does not expose fixed SL, TP, or lot values here. The AI system finalizes them at trigger time.
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <div className="xl:col-span-1">
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">{aiManagedExecution ? "Lots (AI)" : "Lots"}</Label>
                  <Input value={liveLotsDisplay} readOnly className="border-[#2b2b2b] bg-[#0c0c0c] text-white" />
                </div>
                <div className="xl:col-span-1">
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">{aiManagedExecution ? "SL (AI)" : "SL"}</Label>
                  {aiManagedExecution ? (
                    <Input value={liveSlDisplay} readOnly className="border-[#2b2b2b] bg-[#0c0c0c] text-white" />
                  ) : (
                    <Input type="number" step="any" value={slValue ?? ""} onChange={(e) => setSlValue(e.target.value ? parseFloat(e.target.value) : undefined)} className="border-[#2b2b2b] bg-[#0c0c0c] text-white" />
                  )}
                </div>
                <div className="xl:col-span-1">
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">{aiManagedExecution ? "TP (AI)" : "TP (from RR)"}</Label>
                  <Input type={aiManagedExecution ? "text" : "number"} step={aiManagedExecution ? undefined : "any"} value={liveTpDisplay} readOnly className="border-[#2b2b2b] bg-[#0c0c0c] text-white" />
                </div>
                <div className="xl:col-span-1">
                  <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">Order Type</Label>
                  <div className="flex h-10 overflow-hidden rounded-lg border border-[#2b2b2b] text-xs font-semibold">
                    {(["market", "limit", "stop"] as const).map((t) => (
                      <button key={t} type="button" onClick={() => setOrderType(t)}
                        className={`flex-1 transition-colors ${orderType === t ? "bg-orange-600 text-white" : "bg-[#0c0c0c] text-gray-500 hover:text-white"}`}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                {orderType !== "market" && (
                  <div className="xl:col-span-1">
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">
                      {orderType === "limit" ? "Limit Price" : "Stop Price"}
                    </Label>
                    <Input
                      type="number" step="any" placeholder="required"
                      value={pendingPrice}
                      onChange={(e) => setPendingPrice(e.target.value)}
                      className="border-[#2b2b2b] bg-[#0c0c0c] text-white placeholder:text-red-900"
                    />
                  </div>
                )}
                <div className="xl:col-span-2 flex items-end">
                  <Button onClick={handlePlaceTrade} disabled={isPending || !selectedConnectionId || !selectedSymbol || aiManagedExecution || !Number.isFinite(lotSuggestion) || lotSuggestion <= 0} className="h-10 w-full bg-orange-600 text-white hover:bg-orange-500 disabled:bg-[#1a1a1a] disabled:text-gray-500 disabled:hover:bg-[#1a1a1a]">
                    {isPending ? "Queueing…" : orderType === "market" ? `Queue ${side.toUpperCase()} Trade` : `Place ${orderType.charAt(0).toUpperCase() + orderType.slice(1)} Order`}
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 text-xs text-gray-500 sm:grid-cols-3">
                <div className="rounded-lg bg-[#0c0c0c] p-3">Risk amount <span className="block pt-1 text-sm font-semibold text-white">{fmtCurrency(riskAmount)}</span></div>
                <div className="rounded-lg bg-[#0c0c0c] p-3">{aiManagedExecution ? "Lot sizing" : "Suggested lots"} <span className="block pt-1 text-sm font-semibold text-white">{aiManagedExecution ? "AI" : (Number.isFinite(lotSuggestion) && lotSuggestion > 0 ? lotSuggestion.toFixed(2) : "0.01")}</span></div>
                <div className="rounded-lg bg-[#0c0c0c] p-3">Stop mode <span className="block pt-1 text-sm font-semibold text-white">{formatStopModeLabel(stopMode)}</span></div>
              </div>
              {aiManagedExecution ? (
                <div className="mt-2 text-[11px] text-gray-500">AI Dynamic mode keeps stop distance, TP, and lot size under AI control until the execution trigger confirms.</div>
              ) : (
                <>
                  <div className="mt-2 text-[11px] text-gray-500">Lot sizing source: <span className="font-semibold text-gray-200">{lotSizing.method === "broker" ? "broker pip value + volume step" : "fallback pip estimate"}</span></div>
                  <div className="mt-1 text-[11px] text-gray-500">Stop distance: <span className="font-semibold text-gray-200">{lotSizing.stopDistancePips > 0 ? lotSizing.stopDistancePips.toFixed(2) : "0.00"} pips</span> · Pip value/lot: <span className="font-semibold text-gray-200">{lotSizing.pipValuePerLot > 0 ? fmtCurrency(lotSizing.pipValuePerLot) : "—"}</span></div>
                </>
              )}
              <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
                <span>Feed status:</span>
                <span className={`inline-flex items-center gap-1.5 font-semibold ${feedStatus.tone}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${feedStatus.dot}`} />
                  {feedStatus.label}
                </span>
                <span className="text-gray-600">· {feedStatus.detail}</span>
                {isPairSwitchLoading ? <span className="text-orange-300">· syncing {selectedSymbol}</span> : null}
              </div>
              {manualResult && <div className="mt-3"><InlineMessage ok={manualResult.ok} message={manualResult.msg} /></div>}
            </div>

            <div className="rounded-xl border border-[#1f1f1f] bg-[#121212] p-4">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <History className="size-4" /> Runtime Snapshot
              </div>
              <div className="mb-3 rounded-lg border border-[#202020] bg-[#0f0f0f] p-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.18em] text-gray-500">
                  <span>Execution Mode</span>
                  <span className="text-[10px] text-gray-600">per connection</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(["legacy-worker", "ea-first"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => void handleExecutionModeChange(mode)}
                      disabled={!selectedConnectionId || executionModeSaving || mode === executionMode}
                      className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${executionMode === mode ? "border-orange-500 bg-orange-500/15 text-orange-200" : "border-[#252525] bg-[#121212] text-gray-400 hover:text-white"}`}
                    >
                      {mode === "legacy-worker" ? "Legacy Worker" : "EA First"}
                    </button>
                  ))}
                </div>
              </div>
              <dl className="space-y-2 text-xs">
                <MetricRow label="Last heartbeat" value={timeAgo(accountHeartbeat?.last_seen_at)} />
                <MetricRow label="Free margin" value={fmtCurrency(freeMargin)} />
                <MetricRow label="Margin used" value={fmtCurrency(margin)} />
                <MetricRow label={executionMode === "legacy-worker" ? "Recent jobs" : "Recent command events"} value={String(executionStreamItems.length)} />
              </dl>
              <div className="mt-4 rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs leading-relaxed text-blue-200">
                {executionMode === "legacy-worker"
                  ? "This connection is using the legacy worker path: the terminal submits queued trade jobs, reads live candles and prices, tracks setup states, and shows worker heartbeat data."
                  : "This connection is using the EA-first path: the terminal publishes commands, listens for acknowledgements and EA runtime events, and keeps config in sync through the control plane."}
              </div>
            </div>
          </div>
        </section>

        <aside className="order-3 rounded-xl border border-[#1f1f1f] bg-[#101010] lg:order-none lg:rounded-none lg:border-y-0 lg:border-r-0 lg:border-l lg:border-[#1a1a1a]">
          <div className="space-y-6 p-4 lg:p-5">
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Shield className="size-4" /> Risk Management
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-3">
                <div className="space-y-2 rounded-lg bg-[#0f0f0f] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Stop Mode</span>
                    <span className="font-semibold text-white">{formatStopModeLabel(stopMode)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => setStopMode("manual")} className={`h-10 rounded-lg text-[11px] font-semibold ${stopMode === "manual" ? "bg-blue-600 text-white" : "bg-[#111] text-gray-400"}`}>Manual</button>
                    <button type="button" onClick={() => setStopMode("ai_dynamic")} className={`h-10 rounded-lg text-[11px] font-semibold ${stopMode === "ai_dynamic" ? "bg-blue-600 text-white" : "bg-[#111] text-gray-400"}`}>AI Dynamic</button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    Manual means the user enters the stop loss directly. AI Dynamic reads the active structure and places the stop just below the confirmed swing low for buys or just above the confirmed swing high for sells.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setRiskMode("percent")} className={`h-10 rounded-lg text-sm font-semibold ${riskMode === "percent" ? "bg-blue-600 text-white" : "bg-[#111] text-gray-400"}`}>Risk %</button>
                  <button type="button" onClick={() => setRiskMode("usd")} className={`h-10 rounded-lg text-sm font-semibold ${riskMode === "usd" ? "bg-blue-600 text-white" : "bg-[#111] text-gray-400"}`}>Risk $</button>
                </div>
                {riskMode === "percent" ? (
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">Risk Percentage</Label>
                    <Input type="number" step="0.1" min="0" max="100" value={riskPercent} onChange={(e) => setRiskPercent(parseFloat(e.target.value) || 0)} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                ) : (
                  <div>
                    <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">Risk Amount</Label>
                    <Input type="number" step="10" min="0" value={riskUsd} onChange={(e) => setRiskUsd(parseFloat(e.target.value) || 0)} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                )}
                <div className="rounded-lg bg-[#0f0f0f] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Max Trades / Day</span>
                    <span className="font-semibold text-white">{maxTradesPerDay}</span>
                  </div>
                  <input type="range" min={1} max={10} step={1} value={Math.min(maxTradesPerDay, 10)} onChange={(e) => setMaxTradesPerDay(parseInt(e.target.value, 10))} className="w-full accent-blue-500" />
                  <div className="flex items-center justify-between text-[11px] text-gray-500">
                    <span>Queued today</span>
                    <span className="font-semibold text-gray-300">{todaysTradeCount}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-[#0f0f0f] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Risk / Reward</span>
                    <span className="font-semibold text-emerald-300">1:{riskRewardRatio.toFixed(1)}</span>
                  </div>
                  <input type="range" min={1} max={20} step={0.5} value={riskRewardRatio} onChange={(e) => setRiskRewardRatio(parseFloat(e.target.value))} className="w-full accent-emerald-500" />
                </div>

                <div className="rounded-lg bg-[#0f0f0f] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Min AI Confidence</span>
                    <span className="font-semibold text-purple-300">{minConfidence === 0 ? "Off" : `${minConfidence}%`}</span>
                  </div>
                  <input type="range" min={0} max={100} step={5} value={minConfidence} onChange={(e) => setMinConfidence(parseInt(e.target.value, 10))} className="w-full accent-purple-500" />
                  <p className="text-[11px] text-gray-600 leading-snug">EA skips setups where AI confidence is below this threshold. 0 = disabled.</p>
                </div>

                {/* EA Execution Flags */}
                <div className="space-y-2 pt-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-gray-600">EA Execution Flags</p>
                  <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-xs text-gray-300">
                    <span>Exit on Bias Flip</span>
                    <input type="checkbox" checked={exitOnFlip} onChange={(e) => setExitOnFlip(e.target.checked)} className="accent-orange-500" />
                  </label>
                  <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-xs text-gray-300">
                    <span>Dead SL (loss cooldown)</span>
                    <input type="checkbox" checked={useDeadSl} onChange={(e) => setUseDeadSl(e.target.checked)} className="accent-orange-500" />
                  </label>
                  {useDeadSl && (
                    <div>
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">SL Cooldown (min)</Label>
                      <Input type="number" step="5" min="0" max="1440" value={slCooldownMin} onChange={(e) => setSlCooldownMin(parseInt(e.target.value, 10) || 0)} className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8" />
                    </div>
                  )}
                </div>

                {/* Account-level guardrails */}
                <div className="space-y-2 pt-1">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-gray-600">Account Guardrails <span className="text-gray-700">(0 = disabled)</span></p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Daily Loss Limit $</Label>
                      <Input
                        type="number" step="10" min="0"
                        value={dailyLossLimitUsd}
                        onChange={(e) => setDailyLossLimitUsd(parseFloat(e.target.value) || 0)}
                        className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8"
                        placeholder="0 = off"
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Profit Target $</Label>
                      <Input
                        type="number" step="10" min="0"
                        value={dailyProfitTargetUsd}
                        onChange={(e) => setDailyProfitTargetUsd(parseFloat(e.target.value) || 0)}
                        className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8"
                        placeholder="0 = off"
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Max Lot Size</Label>
                      <Input
                        type="number" step="0.01" min="0"
                        value={maxPositionSizeLots}
                        onChange={(e) => setMaxPositionSizeLots(parseFloat(e.target.value) || 0)}
                        className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8"
                        placeholder="0 = off"
                      />
                    </div>
                    <div>
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Max Drawdown %</Label>
                      <Input
                        type="number" step="1" min="0" max="100"
                        value={maxDrawdownPercent}
                        onChange={(e) => setMaxDrawdownPercent(parseFloat(e.target.value) || 0)}
                        className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8"
                        placeholder="0 = off"
                      />
                    </div>
                  </div>
                </div>
                {stopMode === "ai_dynamic" ? (
                  <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-200">
                    <div className="flex items-center justify-between gap-3">
                      <span>AI Dynamic SL</span>
                      <span className="font-semibold text-white">{dynamicStopLoading ? "Loading…" : aiStructureReady ? "AI" : "Waiting"}</span>
                    </div>
                    <div className="mt-2 space-y-1 text-[11px] text-blue-100/90">
                      <div>Pivot window: {pivotWindow}</div>
                      <div>Final SL, TP, and lot size are set by AI from your armed risk settings at trigger time.</div>
                      <div>{dynamicStopState.message ?? "AI Dynamic SL uses the confirmed swing from the active structure read."}</div>
                    </div>
                  </div>
                ) : null}
                {executionBlocker ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
                    Execution blocked: {executionBlocker}
                  </div>
                ) : (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                    Risk settings sync: {settingsSyncState === "saved" ? "server + local saved" : settingsSyncState === "saving" ? "saving…" : settingsSyncState === "pending-migration" ? "waiting for terminal settings migration" : settingsSyncState === "error" ? "local saved; server sync failed" : "local ready"}.
                  </div>
                )}
                <div className="space-y-2 rounded-lg border border-[#232323] bg-[#111] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">Trade Automation</div>
                  <p className="text-xs leading-relaxed text-gray-500">
                    Monitor Zone starts state tracking first. In AI Dynamic mode, the AI system finalizes SL, TP, and lot size only when the trigger happens.
                  </p>
                  <div className="rounded-lg border border-[#1f1f1f] bg-[#0c0c0c] px-3 py-2 text-[11px] text-gray-400">
                    {tradeNowPrereqMsg}
                  </div>
                  <Button
                    onClick={handleTradeNow}
                    disabled={!tradeNowButtonEnabled}
                    className={`h-10 w-full ${tradeNowArmed ? "bg-orange-500/20 text-orange-300 hover:bg-orange-500/20" : tradeNowButtonEnabled ? "bg-orange-600 text-white hover:bg-orange-500" : "bg-[#1a1a1a] text-gray-500 hover:bg-[#1a1a1a]"}`}
                  >
                    {tradeNowSaving ? "Arming…" : tradeNowArmed ? "ARMED" : "TRADE NOW"}
                  </Button>
                  {tradeNowResult && <InlineMessage ok={tradeNowResult.ok} message={tradeNowResult.msg} accent="orange" />}
                </div>
              </div>
            </section>

            {/* ── Statistics ── */}
            <section className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">Statistics</div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-[#0f0f0f] px-3 py-2">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Today&apos;s Trades</div>
                    <div className="text-white font-semibold">{eaLiveState?.daily_trades ?? 0} / {maxTradesPerDay}</div>
                  </div>
                  <div className="rounded-lg bg-[#0f0f0f] px-3 py-2">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Win Rate</div>
                    <div className="text-white font-semibold">{eaLiveState?.win_rate != null ? `${(eaLiveState.win_rate * 100).toFixed(0)}%` : "—"}</div>
                  </div>
                  <div className="rounded-lg bg-[#0f0f0f] px-3 py-2">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Avg R:R</div>
                    <div className="text-white font-semibold">{eaLiveState?.avg_rr != null ? eaLiveState.avg_rr.toFixed(2) : "—"}</div>
                  </div>
                  <div className="rounded-lg bg-[#0f0f0f] px-3 py-2">
                    <div className="text-gray-500 text-[10px] uppercase tracking-wide mb-0.5">Max DD</div>
                    <div className="text-white font-semibold">{eaLiveState?.max_drawdown_pct != null ? `${eaLiveState.max_drawdown_pct.toFixed(1)}%` : "—"}</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                  <AlertTriangle className="size-4" /> Session + News Controls
                </div>
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-3 text-xs">
                <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-gray-300">
                  <span>News Filter</span>
                  <input type="checkbox" checked={newsFilter} onChange={(e) => setNewsFilter(e.target.checked)} className="accent-orange-500" />
                </label>
                {newsFilter && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-gray-500">
                      <span>Block before (min)</span>
                      <span>Block after (min)</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input type="number" value={newsBeforeMin} onChange={(e) => setNewsBeforeMin(parseInt(e.target.value, 10) || 0)} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                      <Input type="number" value={newsAfterMin} onChange={(e) => setNewsAfterMin(parseInt(e.target.value, 10) || 0)} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                    </div>
                    <p className="text-[11px] text-gray-500 leading-snug">The EA/runtime blocks MT5 order execution within this window around any HIGH-impact event for the traded symbol&apos;s currencies.</p>
                  </div>
                )}
                {!newsFilter && (
                  <div className="grid grid-cols-2 gap-2 opacity-50 pointer-events-none">
                    <Input type="number" value={newsBeforeMin} onChange={() => {}} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                    <Input type="number" value={newsAfterMin} onChange={() => {}} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
                  </div>
                )}
                {/* Session rows with editable times */}
                <div className="space-y-2">
                  {([
                    { label: "London", on: sessions.london, setOn: (v: boolean) => setSessions(p => ({ ...p, london: v })), start: londonStart, setStart: setLondonStart, end: londonEnd, setEnd: setLondonEnd },
                    { label: "New York", on: sessions.newYork, setOn: (v: boolean) => setSessions(p => ({ ...p, newYork: v })), start: nyStart, setStart: setNyStart, end: nyEnd, setEnd: setNyEnd },
                    { label: "Asia", on: sessions.asia, setOn: (v: boolean) => setSessions(p => ({ ...p, asia: v })), start: asiaStart, setStart: setAsiaStart, end: asiaEnd, setEnd: setAsiaEnd },
                  ] as const).map(({ label, on, setOn, start, setStart, end, setEnd }) => (
                    <div key={label} className="rounded-lg bg-[#0f0f0f] px-3 py-2 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-300">{label}</span>
                        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-blue-500" />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-[10px] text-gray-600">Start</span>
                          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="h-7 border-[#2b2b2b] bg-[#0c0c0c] text-[11px] text-white mt-0.5" />
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-600">End</span>
                          <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="h-7 border-[#2b2b2b] bg-[#0c0c0c] text-[11px] text-white mt-0.5" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="leading-relaxed text-gray-500">Sessions are enforced server-side before every job insert. If none are enabled, execution is blocked.</p>
              </div>
            </section>

            {/* Discord notifications */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <Bell className="size-4" /> Discord Notifications
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-2 text-xs">
                <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-gray-300">
                  <span>Enable Discord Alerts</span>
                  <input type="checkbox" checked={enableDiscord} onChange={(e) => setEnableDiscord(e.target.checked)} className="accent-indigo-500" />
                </label>
                {enableDiscord && (
                  <>
                    <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-gray-300">
                      <span>Notify on SL Hit</span>
                      <input type="checkbox" checked={notifyOnSL} onChange={(e) => setNotifyOnSL(e.target.checked)} className="accent-indigo-500" />
                    </label>
                    <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-gray-300">
                      <span>Notify on TP Hit</span>
                      <input type="checkbox" checked={notifyOnTP} onChange={(e) => setNotifyOnTP(e.target.checked)} className="accent-indigo-500" />
                    </label>
                    <label className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2 text-gray-300">
                      <span>Daily P&amp;L Summary</span>
                      <input type="checkbox" checked={notifyDaily} onChange={(e) => setNotifyDaily(e.target.checked)} className="accent-indigo-500" />
                    </label>
                    <div className="pt-1">
                      <Label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Webhook URL</Label>
                      <Input
                        type="url"
                        value={discordWebhookUrl}
                        onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                        placeholder="https://discord.com/api/webhooks/..."
                        className="border-[#2b2b2b] bg-[#0f0f0f] text-xs text-white h-8"
                      />
                    </div>
                  </>
                )}
                <p className="leading-relaxed text-gray-500">Enter your Discord webhook URL above. These toggles control which events trigger a notification.</p>
              </div>
            </section>

            {/* Economic calendar panel */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                  <Calendar className="size-4" /> Economic Calendar
                </div>
                <button
                  onClick={() => void fetchNewsEvents()}
                  disabled={newsEventsLoading}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-gray-500 hover:text-white hover:bg-[#1a1a1a] transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={`size-3 ${newsEventsLoading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-2 text-xs">
                {newsEventsStatus === "no_table" && (
                  <p className="text-amber-400/80 leading-snug">
                    Economic events table not found. Run <span className="font-mono text-white">docs/economic_events_migration.sql</span> in Supabase, then <span className="font-mono text-white">python runtime/news_refresh.py</span> to populate.
                  </p>
                )}
                {newsEventsStatus === "error" && (
                  <p className="text-red-400/80">Failed to load events. Check your connection.</p>
                )}
                {newsEventsStatus === "idle" && newsEventsLoading && (
                  <p className="text-gray-500 animate-pulse">Loading events…</p>
                )}
                {(newsEventsStatus === "ok" || newsEventsStatus === "idle") && !newsEventsLoading && newsEvents.length === 0 && (
                  <p className="text-gray-600">No HIGH/MEDIUM events in the next 48 hours.</p>
                )}
                {newsEvents.length > 0 && (
                  <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                    {newsEvents.map((ev) => {
                      const dt = new Date(ev.scheduled_at_utc);
                      const now = new Date();
                      const minsTo = (dt.getTime() - now.getTime()) / 60000;
                      const isHigh = ev.impact === "high";
                      const isInWindow = newsFilter && isHigh && minsTo >= -newsAfterMin && minsTo <= newsBeforeMin;
                      return (
                        <div
                          key={ev.id}
                          className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${
                            isInWindow
                              ? "bg-red-500/10 border border-red-500/30"
                              : isHigh
                              ? "bg-[#0f0f0f] border border-[#1e1e1e]"
                              : "bg-[#0a0a0a]"
                          }`}
                        >
                          <div className="flex-shrink-0 mt-0.5">
                            <span className={`inline-block size-2 rounded-full ${isHigh ? "bg-red-500" : "bg-amber-500"}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className={`font-semibold ${isHigh ? "text-red-300" : "text-amber-300"}`}>{ev.currency}</span>
                              <span className="text-gray-300 truncate">{ev.title}</span>
                              {isInWindow && (
                                <span className="text-[10px] font-bold text-red-400 bg-red-400/10 px-1 rounded">BLOCKED</span>
                              )}
                            </div>
                            <div className="text-gray-500 mt-0.5">
                              {dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}{" "}
                              {dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                              {minsTo > 0 && minsTo < 1440 && (
                                <span className="ml-1.5 text-gray-600">
                                  (in {minsTo < 60 ? `${Math.round(minsTo)}m` : `${(minsTo / 60).toFixed(1)}h`})
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[11px] text-gray-600 leading-snug pt-1">
                  Data from ECB · ONS · BOJ · SNB · RBA · BOC · RBNZ · BLS (+ FRED when key configured). Refresh weekly via <span className="font-mono">python runtime/news_refresh.py</span>.
                </p>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                <CheckCircle2 className="size-4" /> Terms + Execution
              </div>
              <div className="rounded-xl border border-[#202020] bg-[#151515] p-3 space-y-3 text-xs">
                <label className="flex items-start gap-2 rounded-lg bg-[#0f0f0f] p-3 text-gray-300">
                  <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="mt-0.5 accent-blue-500" />
                  <span>I accept the trading risk terms required before queueing MT5 execution from this terminal route.</span>
                </label>
                <Button variant="outline" onClick={() => setTermsOpen(true)} className="w-full border-[#2b2b2b] bg-[#111] text-gray-200 hover:bg-[#181818]">Review Terms</Button>
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 leading-relaxed text-blue-200">
                  Terms acceptance is persisted locally and synced to the server under version <span className="font-semibold text-white">{TERMS_VERSION}</span>. Acceptance is required before any MT5 order can be queued.
                </div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    );
  }

  async function handleClosePosition(pos: MT5Position) {
    if (!selectedConnectionId) return;
    if (!requireAuthenticated("queue a close order")) return;
    setClosingTickets((prev) => new Set(prev).add(pos.ticket));
    try {
      const result = await closeTradeJob({
        connectionId: selectedConnectionId,
        ticket: pos.ticket,
        symbol: pos.symbol,
        volume: pos.volume,
        side: pos.type,
      });
      if (result.ok) {
        toast.success(`Close order queued for ${pos.symbol} #${pos.ticket}`);
      } else {
        toast.error(`Failed to queue close: ${result.reason}`);
      }
    } catch (err) {
      toast.error(`Close error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setClosingTickets((prev) => { const s = new Set(prev); s.delete(pos.ticket); return s; });
    }
  }

  async function handleExecutionModeChange(nextMode: EaExecutionMode) {
    if (!selectedConnectionId || executionModeSaving || nextMode === executionMode) return;
    if (!requireAuthenticated("change execution mode")) return;

    setExecutionModeSaving(true);
    try {
      const result = await saveConnectionExecutionMode({
        connectionId: selectedConnectionId,
        executionMode: nextMode,
      });
      if (result.ok) {
        setExecutionMode(result.executionMode);
        toast.success(`Execution mode set to ${result.executionMode}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update execution mode");
    } finally {
      setExecutionModeSaving(false);
    }
  }

  function renderPositions() {
    const totalProfit = openPositions.reduce((sum, p) => sum + p.profit + p.swap, 0);
    const profitColor = totalProfit >= 0 ? "text-emerald-300" : "text-red-300";

    return (
      <div className="space-y-4">
        {/* Account snapshot strip */}
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
              <TrendingUp className="size-4 text-emerald-400" /> Runtime Account Snapshot
            </div>
            <span className="text-xs text-gray-500">Auto-refreshes every heartbeat cycle (~5 s)</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 md:grid-cols-6">
            <MetricCard label="Balance" value={fmtCurrency(accountBalance)} />
            <MetricCard label="Equity" value={fmtCurrency(accountEquity)} accent="text-emerald-300" />
            <MetricCard label="Margin" value={fmtCurrency(margin)} />
            <MetricCard label="Free Margin" value={fmtCurrency(freeMargin)} accent="text-blue-300" />
            <MetricCard
              label="Floating P&L"
              value={fmtCurrency(totalProfit)}
              accent={profitColor}
            />
            <MetricCard label="Open Trades" value={String(openPositions.length)} />
            <MetricCard label="Armed Setups" value={String(armedSetupRows.length)} accent="text-orange-300" />
          </div>
        </div>

        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
              <Target className="size-4 text-orange-400" /> Armed Waiting Setups
            </div>
            <span className="text-xs text-gray-500">
              {armedSetupRows.length} armed setup{armedSetupRows.length !== 1 ? "s" : ""}
            </span>
          </div>

          {armedSetupRows.length === 0 ? (
            <EmptyState
              title="No armed setups"
              description="When Trade Now is armed, the waiting setup will appear here until the trigger queues the MT5 order."
              icon={Target}
            />
          ) : (
            <div className="space-y-3">
              {armedSetupRows.map((setup) => {
                const state = setup.displayState ?? "IDLE";
                const stateUi = SETUP_STATE_CFG[state];
                const digits = getDecimals(setup.symbol);
                return (
                  <div key={setup.id} className="rounded-lg border border-[#202020] bg-[#151515] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-semibold text-white">{setup.symbol}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${setup.side === "buy" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                            {setup.side}
                          </span>
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${stateUi.badge}`}>
                            <span className={`size-1.5 rounded-full ${stateUi.dot}`} />
                            {stateUi.label}
                          </span>
                          <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                            Waiting for trigger
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-gray-500">
                          Armed Trade Now setup. It will appear in live execution once the setup reaches stalking state and the matching AI trigger fires.
                        </div>
                      </div>
                      <div className="text-xs text-gray-400">
                        Timeframe <span className="font-semibold text-gray-200">{setup.timeframe}</span>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-lg bg-[#0f0f0f] p-3">
                        <div className="text-gray-500">Entry</div>
                        <div className="mt-1 font-mono text-white">{(setup.pivot ?? setup.entry_price ?? 0).toFixed(digits)}</div>
                      </div>
                      <div className="rounded-lg bg-[#0f0f0f] p-3">
                        <div className="text-gray-500">Zone</div>
                        <div className="mt-1 font-mono text-blue-300">{setup.zone.low.toFixed(digits)} - {setup.zone.high.toFixed(digits)}</div>
                      </div>
                      <div className="rounded-lg bg-[#0f0f0f] p-3">
                        <div className="text-gray-500">Live Bid</div>
                        <div className="mt-1 font-mono text-emerald-300">{setup.livePrice ? setup.livePrice.bid.toFixed(digits) : "—"}</div>
                      </div>
                      <div className="rounded-lg bg-[#0f0f0f] p-3">
                        <div className="text-gray-500">Live Ask</div>
                        <div className="mt-1 font-mono text-red-300">{setup.livePrice ? setup.livePrice.ask.toFixed(digits) : "—"}</div>
                      </div>
                      <div className="rounded-lg bg-[#0f0f0f] p-3">
                        <div className="text-gray-500">State</div>
                        <div className="mt-1 text-gray-200">{stateUi.desc}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Open positions workstation */}
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
              <Target className="size-4 text-blue-400" /> Open Positions
            </div>
            <span className="text-xs text-gray-500">
              {openPositions.length} position{openPositions.length !== 1 ? "s" : ""}
            </span>
          </div>

          {openPositions.length === 0 ? (
            <EmptyState
              title="No open positions"
              description="Positions are pushed live from the MT5 runtime. They appear here as soon as a trade is executed."
              icon={TrendingUp}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#202020] text-left text-gray-500">
                    <th className="pb-2 pr-4 font-medium">Ticket</th>
                    <th className="pb-2 pr-4 font-medium">Symbol</th>
                    <th className="pb-2 pr-4 font-medium">Side</th>
                    <th className="pb-2 pr-4 font-medium">Volume</th>
                    <th className="pb-2 pr-4 font-medium">Open</th>
                    <th className="pb-2 pr-4 font-medium">Current</th>
                    <th className="pb-2 pr-4 font-medium">SL</th>
                    <th className="pb-2 pr-4 font-medium">TP</th>
                    <th className="pb-2 pr-4 font-medium">P&L</th>
                    <th className="pb-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1a1a]">
                  {openPositions.map((pos) => {
                    const pnl = pos.profit + pos.swap;
                    const pnlColor = pnl >= 0 ? "text-emerald-300" : "text-red-300";
                    const sideColor = pos.type === "buy" ? "text-emerald-400" : "text-red-400";
                    const isClosing = closingTickets.has(pos.ticket);
                    const decimals = getDecimals(pos.symbol);
                    return (
                      <tr key={pos.ticket} className="group hover:bg-[#141414]">
                        <td className="py-2.5 pr-4 font-mono text-gray-400">#{pos.ticket}</td>
                        <td className="py-2.5 pr-4 font-mono font-semibold text-white">{pos.symbol}</td>
                        <td className={`py-2.5 pr-4 font-semibold uppercase tracking-wide ${sideColor}`}>{pos.type}</td>
                        <td className="py-2.5 pr-4 text-gray-300">{pos.volume}</td>
                        <td className="py-2.5 pr-4 font-mono text-gray-300">{pos.open_price.toFixed(decimals)}</td>
                        <td className="py-2.5 pr-4 font-mono text-white">{pos.current_price.toFixed(decimals)}</td>
                        <td className="py-2.5 pr-4 font-mono text-amber-400">{pos.sl ? pos.sl.toFixed(decimals) : "—"}</td>
                        <td className="py-2.5 pr-4 font-mono text-blue-400">{pos.tp ? pos.tp.toFixed(decimals) : "—"}</td>
                        <td className={`py-2.5 pr-4 font-mono font-semibold ${pnlColor}`}>
                          {pnl >= 0 ? "+" : ""}{fmtCurrency(pnl)}
                        </td>
                        <td className="py-2.5">
                          <button
                            onClick={() => void handleClosePosition(pos)}
                            disabled={isClosing || !termsAccepted}
                            className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {isClosing ? "Closing…" : "Close"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Execution stream */}
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-200">
              <History className="size-4 text-orange-400" /> Execution Stream
            </div>
            <span className="text-xs text-gray-500">{executionStreamItems.length} recent {executionMode === "legacy-worker" ? "jobs" : "events"}</span>
          </div>
          <div className="space-y-3">
            {executionStreamItems.length ? executionStreamItems.map((item) => (
              <div key={item.id} className="rounded-lg border border-[#202020] bg-[#151515] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-semibold text-white">{item.title}</div>
                    <div className="text-xs text-gray-500">{item.detail}</div>
                  </div>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                  <span>{new Date(item.timestamp).toLocaleString()}</span>
                  <span>{item.source === "job" ? "worker" : item.source === "command" ? "command" : item.source === "ack" ? "ack" : "ea-event"}</span>
                </div>
                {item.error ? <div className="mt-2 text-xs text-red-300">{item.error}</div> : null}
              </div>
            )) : <EmptyState title={executionMode === "legacy-worker" ? "No trade jobs yet" : "No EA command activity yet"} description={executionMode === "legacy-worker" ? "Queued and executed MT5 jobs will stream here in real time." : "Queued commands, acknowledgements, and EA runtime events will stream here in real time."} icon={History} />}
          </div>
        </div>
      </div>
    );
  }

  function renderCopyTrading() {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5 lg:col-span-2">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-200">
            <Users className="size-4 text-blue-400" /> Copy Trading Migration Status
          </div>
          <div className="space-y-3 text-sm text-gray-400">
            <p>The prototype copy-trading UX has been acknowledged and the real `/terminal` route is now in place, but backend execution mirroring is still pending.</p>
            <ul className="list-disc space-y-2 pl-5 text-gray-500">
              <li>UI shell is still to be ported from the prototype cards.</li>
              <li>Follow state persistence needs new tables/RPCs.</li>
              <li>Leader-to-follower `trade_jobs` mirroring is not wired yet.</li>
            </ul>
          </div>
        </div>
        <div className="rounded-xl border border-dashed border-[#2a2a2a] bg-[#0f0f0f] p-5">
          <EmptyState title="Planned next" description="Port prototype leaderboard cards and follow controls after the terminal shell stabilizes." icon={Users} compact />
        </div>
      </div>
    );
  }

  function renderManualTrades() {
    return (
      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-200">
            <Edit3 className="size-4 text-orange-400" /> Manual Execution Workspace
          </div>
          {hydrated && (
            <CandlestickChart
              symbol={displaySymbol}
              liveSymbol={liveQuoteSymbol}
              connId={selectedConnectionId || undefined}
              entryPrice={showEntryZones && validEntry ? parsedEntry : undefined}
              entryZoneLow={showEntryZones && zone ? zone.low : undefined}
              entryZoneHigh={showEntryZones && zone ? zone.high : undefined}
              sl={showEntryZones && !aiManagedExecution ? slValue : undefined}
              tp={showTPZones && !aiManagedExecution ? effectiveTakeProfit : undefined}
              tp1={showTPZones && !useAutoRR && parseFloat(tp1) > 0 ? parseFloat(tp1) : undefined}
              tp2={showTPZones && !useAutoRR && parseFloat(tp2) > 0 ? parseFloat(tp2) : undefined}
              invalidation={zone ? (side === "buy" ? zone.low : zone.high) : undefined}
              prices={prices}
              forming={forming}
              lastClose={lastClose}
              className="w-full"
            />
          )}
        </div>
        <div className="rounded-xl border border-[#1f1f1f] bg-[#101010] p-5 space-y-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-gray-500">Manual Trade Queue</div>
            <div className="mt-1 text-sm text-gray-300">{executionMode === "legacy-worker" ? "This uses the live worker trade job queue." : "This sends control-plane commands and waits for EA acknowledgements."}</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Connection" value={selectedConnection ? `${selectedConnection.account_login} · ${selectedConnection.broker_server}` : "No connection"} />
            <Field label="Symbol" value={selectedSymbol || "—"} />
            <Field label="Side" value={side.toUpperCase()} />
            <Field label={aiManagedExecution ? "Lot Sizing" : "Suggested Lots"} value={aiManagedExecution ? "AI" : lotSuggestion.toFixed(2)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">{aiManagedExecution ? "SL (AI)" : "SL"}</Label>
              {aiManagedExecution ? (
                <Input value="AI" readOnly className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
              ) : (
                <Input type="number" step="any" value={slValue ?? ""} onChange={(e) => setSlValue(e.target.value ? parseFloat(e.target.value) : undefined)} className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
              )}
            </div>
            <div>
              <Label className="mb-1.5 block text-[11px] uppercase tracking-wide text-gray-500">{aiManagedExecution ? "TP (AI)" : "TP (from RR)"}</Label>
              <Input type={aiManagedExecution ? "text" : "number"} step={aiManagedExecution ? undefined : "any"} value={aiManagedExecution ? "AI" : (effectiveTakeProfit ?? "")} readOnly className="border-[#2b2b2b] bg-[#0f0f0f] text-white" />
            </div>
          </div>
          <Button onClick={handlePlaceTrade} disabled={isPending || !selectedConnectionId || !selectedSymbol || aiManagedExecution || !Number.isFinite(lotSuggestion) || lotSuggestion <= 0} className="h-10 w-full bg-orange-600 text-white hover:bg-orange-500 disabled:bg-[#1a1a1a] disabled:text-gray-500 disabled:hover:bg-[#1a1a1a]">
            {isPending ? "Queueing…" : "Queue Manual Trade"}
          </Button>
          {aiManagedExecution ? (
            <div className="mt-2 text-[11px] text-gray-500">Switch Stop Mode to Manual if you want fixed user-entered SL and lot values for immediate execution.</div>
          ) : null}
          {manualResult ? <InlineMessage ok={manualResult.ok} message={manualResult.msg} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#090909] text-white">
      <div className="border-b border-[#1a1a1a] bg-[#111111] px-4 py-3 lg:px-6">
        <div className="hidden items-center justify-between lg:flex">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-900/30">
                <TrendingUp className="size-5 text-white" />
              </div>
              <div>
                <div className="text-xl font-semibold">IFX Manual Terminal</div>
                <div className="text-xs text-gray-500">Live route wired to MT5 runtime, chart feed, setup monitor, and trade queue</div>
                {executionMode === "ea-first" ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge className={latestCommandAck?.status === "rejected" ? "border-red-500/30 bg-red-500/15 text-red-200" : latestCommandAck ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-200" : "border-gray-500/30 bg-gray-500/10 text-gray-300"}>
                      {latestCommandAck ? `EA ack: ${latestCommandAck.status}` : "EA ack: waiting"}
                    </Badge>
                    <span className="text-[11px] text-gray-500">{latestCommandAck ? timeAgo(latestCommandAck.acknowledged_at || latestCommandAck.created_at) : "No acknowledgements yet"}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 text-right text-sm">
            <div>
              <div className="text-xs text-gray-500">Balance</div>
              <div className="font-semibold text-white">{fmtCurrency(accountBalance)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Equity</div>
              <div className="font-semibold text-emerald-300">{fmtCurrency(accountEquity)}</div>
            </div>
            <Button asChild variant="outline" className="border-[#2a2a2a] bg-[#161616] text-gray-200 hover:bg-[#1c1c1c]">
              <Link href="/">Back to Portal</Link>
            </Button>
          </div>
        </div>

        <div className="space-y-3 lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
                <TrendingUp className="size-4 text-white" />
              </div>
              <div>
                <div className="text-sm font-semibold">IFX Terminal</div>
                <div className="text-[10px] text-gray-500">Live MT5 terminal route</div>
                {executionMode === "ea-first" ? (
                  <div className="mt-1 flex items-center gap-2">
                    <Badge className={latestCommandAck?.status === "rejected" ? "border-red-500/30 bg-red-500/15 text-red-200" : latestCommandAck ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-200" : "border-gray-500/30 bg-gray-500/10 text-gray-300"}>
                      {latestCommandAck ? latestCommandAck.status : "waiting"}
                    </Badge>
                    <span className="text-[10px] text-gray-500">{latestCommandAck ? timeAgo(latestCommandAck.acknowledged_at || latestCommandAck.created_at) : "No ack"}</span>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="text-right text-xs">
              <div className="text-gray-500">Equity</div>
              <div className="font-semibold text-emerald-300">{fmtCurrency(accountEquity)}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="hidden lg:flex">
        <div className="w-20 border-r border-[#1a1a1a] bg-[#0a0a0a] py-6">
          <div className="flex flex-col items-center gap-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button key={item.id} onClick={() => setActiveTab(item.id)} className={`flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-xl transition ${active ? "bg-blue-600 text-white shadow-lg shadow-blue-900/30" : "text-gray-500 hover:bg-[#151515] hover:text-gray-200"}`}>
                  <Icon className="size-5" />
                  <span className="text-[9px] font-semibold leading-none">{item.label.split(" ")[0]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 flex-1 p-4 lg:p-0">
          {activeTab === "ai-trading" && renderAITrading()}
          {activeTab === "positions" && renderPositions()}
          {activeTab === "copy-trading" && renderCopyTrading()}
          {activeTab === "manual-trades" && renderManualTrades()}
        </div>
      </div>

      <div className="space-y-4 p-4 pb-24 lg:hidden">
        {activeTab === "ai-trading" && renderAITrading()}
        {activeTab === "positions" && renderPositions()}
        {activeTab === "copy-trading" && renderCopyTrading()}
        {activeTab === "manual-trades" && renderManualTrades()}
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-[#1a1a1a] bg-[#0a0a0a] lg:hidden">
        <div className="grid grid-cols-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button key={item.id} onClick={() => setActiveTab(item.id)} className={`flex h-16 flex-col items-center justify-center gap-1 ${active ? "text-blue-400" : "text-gray-500"}`}>
                <Icon className="size-5" />
                <span className="text-[10px] font-medium">{item.label.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Dialog open={termsOpen} onOpenChange={setTermsOpen}>
        <DialogContent className="max-w-2xl border-[#2a2a2a] bg-[#111] text-white">
          <DialogHeader>
            <DialogTitle>IFX Manual Terminal Terms</DialogTitle>
            <DialogDescription>
              Review this execution-risk notice before using the live MT5 terminal route.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-4 overflow-y-auto rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-4 text-sm leading-relaxed text-gray-300">
            <p>Forex and CFD trading involves substantial risk of loss. Orders queued from this terminal route are transmitted to the live MT5 runtime and may execute automatically once accepted by the worker.</p>
            <p>You are responsible for verifying symbol, side, lot size, stop loss, take profit, and market conditions before queueing any trade.</p>
            <p>The current terminal route already uses the live chart feed, trade queue, setup monitor, and MT5 runtime. Local persistence for terminal settings and terms versioning is now in place, while runtime session/news enforcement is still being completed.</p>
            <p>Only trade with capital you can afford to lose.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTermsOpen(false)} className="border-[#2a2a2a] bg-[#161616] text-gray-200 hover:bg-[#1b1b1b]">Close</Button>
            <Button onClick={() => { setTermsAccepted(true); setTermsOpen(false); }} className="bg-blue-600 text-white hover:bg-blue-500">Accept current version</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={symbolChooserOpen}
        onOpenChange={(open) => {
          setSymbolChooserOpen(open);
          if (!open) setSymbolChooserQuery("");
        }}
      >
        <DialogContent className="max-w-2xl border-[#2a2a2a] bg-[#111] text-white">
          <DialogHeader>
            <DialogTitle>Choose symbol</DialogTitle>
            <DialogDescription>
              Search the live MT5 symbol set and switch the terminal chart without using the side-panel selector.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              value={symbolChooserQuery}
              onChange={(e) => setSymbolChooserQuery(e.target.value)}
              placeholder="Search symbol, description, or category"
              className="h-11 border-[#2b2b2b] bg-[#0f0f0f] text-white"
            />

            <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-2">
              {filteredSymbolChooserOptions.length > 0 ? (
                filteredSymbolChooserOptions.map((option) => (
                  <button
                    key={option.symbol}
                    type="button"
                    onClick={() => chooseSymbolFromModal(option.symbol)}
                    className="flex w-full items-center justify-between rounded-lg border border-transparent bg-[#111] px-3 py-3 text-left transition hover:border-blue-500/30 hover:bg-[#161616]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-white">{option.symbol}</span>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${option.hasLive ? "bg-emerald-500/15 text-emerald-300" : "bg-gray-500/15 text-gray-400"}`}>
                          {option.hasLive ? "Live" : "Waiting"}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {option.description || option.category || "No symbol metadata available"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-gray-600">Bid</div>
                      <div className="font-mono text-sm text-emerald-300">
                        {typeof option.bid === "number" ? option.bid.toFixed(getDecimals(option.symbol)) : "—"}
                      </div>
                    </div>
                  </button>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-[#2a2a2a] px-4 py-8 text-center text-sm text-gray-500">
                  No symbols match your search.
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSymbolChooserOpen(false);
                setSymbolChooserQuery("");
              }}
              className="border-[#2a2a2a] bg-[#161616] text-gray-200 hover:bg-[#1b1b1b]"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={authPromptOpen} onOpenChange={setAuthPromptOpen}>
        <DialogContent className="max-w-md border-[#2a2a2a] bg-[#111] text-white">
          <DialogHeader>
            <DialogTitle>Sign in required</DialogTitle>
            <DialogDescription>
              You can view the terminal anonymously, but you must sign in before you {authPromptIntent}.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-4 text-sm text-gray-300">
            Sign in with your account to load your own MT5 prices, save monitored setups, and route execution to your personal connection. If you do not have a connection yet, continue to the connection page after signing in.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAuthPromptOpen(false)} className="border-[#2a2a2a] bg-[#161616] text-gray-200 hover:bg-[#1b1b1b]">Not now</Button>
            <Button variant="outline" onClick={() => router.push("/login?next=%2Fconnections")} className="border-[#2a2a2a] bg-[#161616] text-gray-200 hover:bg-[#1b1b1b]">Go to Connections</Button>
            <Button onClick={() => router.push("/login?next=%2Fterminal")} className="bg-blue-600 text-white hover:bg-blue-500">Sign In</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InlineMessage({ ok, message, accent = "blue" }: { ok: boolean; message: string; accent?: "blue" | "orange" }) {
  const cls = ok
    ? accent === "orange"
      ? "border-orange-500/20 bg-orange-500/10 text-orange-300"
      : "border-blue-500/20 bg-blue-500/10 text-blue-300"
    : "border-red-500/20 bg-red-500/10 text-red-300";
  return <div className={`rounded-lg border px-3 py-2 text-xs ${cls}`}>{message}</div>;
}

function SessionToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`flex cursor-pointer items-center justify-center rounded-lg border px-2 py-2 text-center text-[11px] font-semibold ${checked ? "border-blue-500/30 bg-blue-500/15 text-blue-300" : "border-[#2a2a2a] bg-[#111] text-gray-400"}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="hidden" />
      {label}
    </label>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-[#0f0f0f] px-3 py-2">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-white">{value}</span>
    </div>
  );
}

function MetricCard({ label, value, accent = "text-white" }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-[#202020] bg-[#151515] p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-2 text-lg font-semibold ${accent}`}>{value}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#202020] bg-[#151515] p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-white">{value}</div>
    </div>
  );
}

function EmptyState({ title, description, icon: Icon, compact = false }: { title: string; description: string; icon: typeof Info; compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border border-dashed border-[#2a2a2a] bg-[#111] text-center ${compact ? "p-4" : "p-8"}`}>
      <Icon className="size-8 text-gray-600" />
      <div className="mt-3 text-sm font-semibold text-gray-200">{title}</div>
      <div className="mt-1 max-w-md text-xs leading-relaxed text-gray-500">{description}</div>
    </div>
  );
}
