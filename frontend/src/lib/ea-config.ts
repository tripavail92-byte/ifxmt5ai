type JsonMap = Record<string, unknown>;

export const EA_CONFIG_SCHEMA_VERSION = 3;

export type EaBias = "neutral" | "buy" | "sell";
export type EaExecutionMode = "ea-first" | "legacy-worker";

export type EaConfigJson = {
  meta: {
    schema_version: number;
    connection_id: string;
    release_channel: string;
    expected_ea_version: string;
    published_at: string;
    migration_source: string | null;
  };
  trading: {
    enabled: boolean;
    execution_mode: EaExecutionMode;
    trade_disable_kill_switch: boolean;
  };
  symbols: {
    active: string[];
    high_priority: string[];
  };
  /** Zone setup — maps to i_manual_bias, i_manual_pivot, i_manual_tp1/tp2, i_atrPct */
  setup: {
    bias: EaBias;
    pivot: number | null;
    tp1: number | null;
    tp2: number | null;
    /** % of daily ATR used as zone thickness — i_atrPct (default 10) */
    atr_zone_thickness_pct: number;
  };
  /** Structure timeframes — i_tf_enforce, i_boss_tf, i_sl_tf, i_be_tf, i_pivotLen */
  structure: {
    mode: "fractal";
    /** Engine timeframe — i_tf_enforce */
    timeframe: string;
    /** Boss / invalidation timeframe — i_boss_tf */
    boss_timeframe: string;
    /** MTF SL anchor timeframe — i_sl_tf */
    sl_timeframe: string;
    /** Break-even trailing timeframe — i_be_tf */
    be_timeframe: string;
    pivot_window: number;
    bars_to_scan: number;
  };
  risk: {
    risk_percent: number;
    /** Abort trade if calc'd lots < min lot — i_strictRisk */
    strict_risk: boolean;
    /** Minimum R:R to accept a setup — i_min_rr */
    min_rr: number;
    max_open_trades: number;
    max_daily_loss_usd: number;
    max_daily_trades: number;
    max_position_size_lots: number | null;
  };
  sessions: {
    asia: { enabled: boolean; start: string; end: string };
    london: { enabled: boolean; start: string; end: string };
    new_york: { enabled: boolean; start: string; end: string };
  };
  /** Trade execution behaviour — maps directly to EA group 5 inputs */
  execution: {
    allow_market_orders: boolean;
    /** SL spread multiplier — i_slPadMult (default 2.0) */
    sl_pad_mult: number;
    /** Use MTF structure anchor for SL — i_use_mtf_sl */
    use_mtf_sl: boolean;
    /** Enable SL cooldown after a loss — i_useDeadSL */
    use_dead_sl: boolean;
    /** Cooldown minutes after SL hit — i_slCooldown */
    sl_cooldown_min: number;
    /** Base magic number for orders — i_base_magic */
    base_magic: number;
    /** Enable split TP1/TP2 orders — i_usePartial */
    partial_take_profit_enabled: boolean;
    /** Portion of position closed at TP1 (%) — i_tp1_pct */
    tp1_pct: number;
    /** Move SL to break-even after TP1 — i_useBE + i_be_after_tp1 */
    break_even_enabled: boolean;
    break_even_after_tp1: boolean;
    /** Use auto RR multipliers instead of explicit TP1/TP2 — i_useAutoRR */
    use_auto_rr: boolean;
    /** Auto RR TP1 multiplier — i_autoRR1 */
    auto_rr1: number;
    /** Auto RR TP2 multiplier — i_autoRR2 */
    auto_rr2: number;
    /** Force close all positions at EOD — i_useEOD */
    close_eod: boolean;
    /** Time string for EOD close — i_eodTime (e.g. "23:50") */
    eod_time: string;
  };
  /** Chart visuals drawn by the EA on the MT5 chart */
  visuals: {
    /** Draw live BOS/SMS structure lines — i_show_struct */
    show_struct: boolean;
    /** Structure history lookback in candles — i_smc_lookback */
    smc_lookback: number;
  };
  /** Discord webhook integration */
  discord: {
    webhook_url: string;
    /** Hour (0-23) to send daily report — i_reportHour */
    report_hour: number;
    /** Minute (0-59) to send daily report — i_reportMin */
    report_min: number;
  };
  telemetry: {
    heartbeat_sec: number;
    config_poll_sec: number;
  };
};

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...fallback];
}

function asBias(value: unknown, fallback: EaBias): EaBias {
  return value === "buy" || value === "sell" || value === "neutral" ? value : fallback;
}

function asExecutionMode(value: unknown, fallback: EaExecutionMode): EaExecutionMode {
  return value === "ea-first" || value === "legacy-worker" ? value : fallback;
}

export function buildDefaultEaConfig(
  connectionId: string,
  options?: {
    activeSymbols?: string[];
    releaseChannel?: string;
    expectedEaVersion?: string;
    publishedAt?: string;
    migrationSource?: string | null;
  },
): EaConfigJson {
  const active = options?.activeSymbols?.filter(Boolean) ?? [];
  const activeSymbols = active.length > 0 ? active : ["EURUSD", "XAUUSD", "USDJPY", "AUDUSD", "USOIL", "GBPUSD"];

  return {
    meta: {
      schema_version: EA_CONFIG_SCHEMA_VERSION,
      connection_id: connectionId,
      release_channel: options?.releaseChannel?.trim() || "stable",
      expected_ea_version: options?.expectedEaVersion?.trim() || "dev-local",
      published_at: options?.publishedAt || new Date().toISOString(),
      migration_source: options?.migrationSource ?? null,
    },
    trading: {
      enabled: false,
      execution_mode: "legacy-worker",
      trade_disable_kill_switch: false,
    },
    symbols: {
      active: activeSymbols,
      high_priority: activeSymbols.slice(0, Math.min(activeSymbols.length, 12)),
    },
    setup: {
      bias: "neutral",
      pivot: null,
      tp1: null,
      tp2: null,
      atr_zone_thickness_pct: 10,
    },
    structure: {
      mode: "fractal",
      timeframe: "M5",
      boss_timeframe: "H1",
      sl_timeframe: "M5",
      be_timeframe: "M10",
      pivot_window: 2,
      bars_to_scan: 120,
    },
    risk: {
      risk_percent: 1,
      strict_risk: false,
      min_rr: 1.0,
      max_open_trades: 1,
      max_daily_loss_usd: 0,
      max_daily_trades: 3,
      max_position_size_lots: null,
    },
    sessions: {
      asia: { enabled: false, start: "19:00", end: "03:00" },
      london: { enabled: true, start: "03:00", end: "11:00" },
      new_york: { enabled: true, start: "08:00", end: "17:00" },
    },
    execution: {
      allow_market_orders: true,
      sl_pad_mult: 2.0,
      use_mtf_sl: true,
      use_dead_sl: true,
      sl_cooldown_min: 30,
      base_magic: 9180,
      partial_take_profit_enabled: true,
      tp1_pct: 75.0,
      break_even_enabled: true,
      break_even_after_tp1: true,
      use_auto_rr: false,
      auto_rr1: 1.0,
      auto_rr2: 2.0,
      close_eod: false,
      eod_time: "23:50",
    },
    visuals: {
      show_struct: false,
      smc_lookback: 400,
    },
    discord: {
      webhook_url: "",
      report_hour: 22,
      report_min: 0,
    },
    telemetry: {
      heartbeat_sec: 30,
      config_poll_sec: 30,
    },
  };
}

export function normalizeEaConfig(
  input: unknown,
  connectionId: string,
  options?: {
    releaseChannel?: string;
    expectedEaVersion?: string;
    publishedAt?: string;
    migrationSource?: string | null;
    activeSymbols?: string[];
  },
): EaConfigJson {
  const defaults = buildDefaultEaConfig(connectionId, options);
  const root = asRecord(input);
  const meta = asRecord(root.meta);
  const trading = asRecord(root.trading);
  const symbols = asRecord(root.symbols);
  const structure = asRecord(root.structure);
  const risk = asRecord(root.risk);
  const setup = asRecord(root.setup);
  const sessions = asRecord(root.sessions);
  const execution = asRecord(root.execution);
  const visuals = asRecord(root.visuals);
  const discord = asRecord(root.discord);
  const telemetry = asRecord(root.telemetry);

  const legacySymbols = asStringArray(root.symbols, defaults.symbols.active);
  const activeSymbols = asStringArray(symbols.active, legacySymbols);
  const highPriority = asStringArray(symbols.high_priority, activeSymbols.slice(0, Math.min(activeSymbols.length, 12)));

  const merged: EaConfigJson = {
    meta: {
      schema_version: EA_CONFIG_SCHEMA_VERSION,
      connection_id: connectionId,
      release_channel: asString(meta.release_channel, defaults.meta.release_channel),
      expected_ea_version: asString(meta.expected_ea_version, defaults.meta.expected_ea_version),
      published_at: asString(meta.published_at, defaults.meta.published_at),
      migration_source:
        typeof meta.migration_source === "string" && meta.migration_source.trim()
          ? meta.migration_source.trim()
          : defaults.meta.migration_source,
    },
    trading: {
      enabled: asBoolean(trading.enabled ?? root.trade_enabled, defaults.trading.enabled),
      execution_mode: asExecutionMode(trading.execution_mode, defaults.trading.execution_mode),
      trade_disable_kill_switch: asBoolean(trading.trade_disable_kill_switch, defaults.trading.trade_disable_kill_switch),
    },
    symbols: {
      active: activeSymbols,
      high_priority: highPriority,
    },
    setup: {
      bias: asBias(setup.bias, defaults.setup.bias),
      pivot: asNullableNumber(setup.pivot),
      tp1: asNullableNumber(setup.tp1),
      tp2: asNullableNumber(setup.tp2),
      atr_zone_thickness_pct: asNumber(setup.atr_zone_thickness_pct, defaults.setup.atr_zone_thickness_pct),
    },
    structure: {
      mode: "fractal",
      timeframe: asString(structure.timeframe, defaults.structure.timeframe),
      boss_timeframe: asString(structure.boss_timeframe, defaults.structure.boss_timeframe),
      sl_timeframe: asString(structure.sl_timeframe, defaults.structure.sl_timeframe),
      be_timeframe: asString(structure.be_timeframe, defaults.structure.be_timeframe),
      pivot_window: asNumber(structure.pivot_window, asNumber(root.pivot_window, defaults.structure.pivot_window)),
      bars_to_scan: asNumber(structure.bars_to_scan, defaults.structure.bars_to_scan),
    },
    risk: {
      risk_percent: asNumber(risk.risk_percent, defaults.risk.risk_percent),
      strict_risk: asBoolean(risk.strict_risk, defaults.risk.strict_risk),
      min_rr: asNumber(risk.min_rr, defaults.risk.min_rr),
      max_open_trades: asNumber(risk.max_open_trades, defaults.risk.max_open_trades),
      max_daily_loss_usd: asNumber(risk.max_daily_loss_usd, defaults.risk.max_daily_loss_usd),
      max_daily_trades: asNumber(risk.max_daily_trades, defaults.risk.max_daily_trades),
      max_position_size_lots: asNullableNumber(risk.max_position_size_lots),
    },
    sessions: {
      asia: {
        enabled: asBoolean(asRecord(sessions.asia).enabled, defaults.sessions.asia.enabled),
        start: asString(asRecord(sessions.asia).start, defaults.sessions.asia.start),
        end: asString(asRecord(sessions.asia).end, defaults.sessions.asia.end),
      },
      london: {
        enabled: asBoolean(asRecord(sessions.london).enabled, defaults.sessions.london.enabled),
        start: asString(asRecord(sessions.london).start, defaults.sessions.london.start),
        end: asString(asRecord(sessions.london).end, defaults.sessions.london.end),
      },
      new_york: {
        enabled: asBoolean(asRecord(sessions.new_york).enabled, defaults.sessions.new_york.enabled),
        start: asString(asRecord(sessions.new_york).start, defaults.sessions.new_york.start),
        end: asString(asRecord(sessions.new_york).end, defaults.sessions.new_york.end),
      },
    },
    execution: {
      allow_market_orders: asBoolean(execution.allow_market_orders, defaults.execution.allow_market_orders),
      sl_pad_mult: asNumber(execution.sl_pad_mult, defaults.execution.sl_pad_mult),
      use_mtf_sl: asBoolean(execution.use_mtf_sl, defaults.execution.use_mtf_sl),
      use_dead_sl: asBoolean(execution.use_dead_sl, defaults.execution.use_dead_sl),
      sl_cooldown_min: asNumber(execution.sl_cooldown_min, defaults.execution.sl_cooldown_min),
      base_magic: asNumber(execution.base_magic, defaults.execution.base_magic),
      partial_take_profit_enabled: asBoolean(execution.partial_take_profit_enabled, defaults.execution.partial_take_profit_enabled),
      tp1_pct: asNumber(execution.tp1_pct, defaults.execution.tp1_pct),
      break_even_enabled: asBoolean(execution.break_even_enabled, defaults.execution.break_even_enabled),
      break_even_after_tp1: asBoolean(execution.break_even_after_tp1, defaults.execution.break_even_after_tp1),
      use_auto_rr: asBoolean(execution.use_auto_rr, defaults.execution.use_auto_rr),
      auto_rr1: asNumber(execution.auto_rr1, defaults.execution.auto_rr1),
      auto_rr2: asNumber(execution.auto_rr2, defaults.execution.auto_rr2),
      close_eod: asBoolean(execution.close_eod, defaults.execution.close_eod),
      eod_time: asString(execution.eod_time, defaults.execution.eod_time),
    },
    visuals: {
      show_struct: asBoolean(visuals.show_struct, defaults.visuals.show_struct),
      smc_lookback: asNumber(visuals.smc_lookback, defaults.visuals.smc_lookback),
    },
    discord: {
      webhook_url: asString(discord.webhook_url, defaults.discord.webhook_url),
      report_hour: asNumber(discord.report_hour, defaults.discord.report_hour),
      report_min: asNumber(discord.report_min, defaults.discord.report_min),
    },
    telemetry: {
      heartbeat_sec: asNumber(telemetry.heartbeat_sec, defaults.telemetry.heartbeat_sec),
      config_poll_sec: asNumber(telemetry.config_poll_sec, defaults.telemetry.config_poll_sec),
    },
  };

  return merged;
}