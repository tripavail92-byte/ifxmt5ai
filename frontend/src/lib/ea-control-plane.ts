import { randomUUID, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildDefaultEaConfig, normalizeEaConfig, type EaExecutionMode } from "@/lib/ea-config";
import { createAdminClient } from "@/utils/supabase/admin";

type JsonMap = Record<string, unknown>;
type AdminClient = ReturnType<typeof createAdminClient>;

const MANAGER_TOKEN = (process.env.TERMINAL_MANAGER_TOKEN ?? "").trim();
const DEFAULT_RELEASE_CHANNEL = (process.env.IFX_EA_RELEASE_CHANNEL ?? "stable").trim() || "stable";
const DEFAULT_EA_VERSION = (process.env.IFX_EA_RELEASE_VERSION ?? "dev-local").trim() || "dev-local";
const DEFAULT_EA_ARTIFACT_URL = (process.env.IFX_EA_ARTIFACT_URL ?? "").trim();
const DEFAULT_EA_SHA256 = (process.env.IFX_EA_RELEASE_SHA256 ?? "").trim();

export type EaCommandType =
  | "manual_trade"
  | "close_position"
  | "arm_trade"
  | "cancel_trade"
  | "sync_config"
  | "set_bias"
  | "set_setup";

function secureEquals(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function unauthorized(message: string, status = 401) {
  return NextResponse.json({ error: message }, { status });
}

function extractBearer(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return "";
  }
  return auth.slice(7).trim();
}

export function requireManagerAuth(req: NextRequest) {
  if (!MANAGER_TOKEN) {
    return unauthorized("TERMINAL_MANAGER_TOKEN not configured", 500);
  }

  const provided = extractBearer(req);
  if (!provided || !secureEquals(provided, MANAGER_TOKEN)) {
    return unauthorized("unauthorized");
  }

  return null;
}

export function isoNow() {
  return new Date().toISOString();
}

export async function parseJsonBody<T>(req: NextRequest) {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function generateInstallToken() {
  return `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

export async function loadConnection(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("mt5_user_connections")
    .select("id, user_id, broker_server, account_login, password_ciphertext_b64, password_nonce_b64, status, is_active, created_at")
    .eq("id", connectionId)
    .limit(1);

  if (error) {
    throw new Error(`Failed to load MT5 connection: ${error.message}`);
  }

  return (data ?? [])[0] ?? null;
}

export async function upsertTerminalHost(
  admin: AdminClient,
  input: {
    hostName: string;
    hostType: string;
    capacity: number;
    metadata?: JsonMap;
    status?: string;
  },
) {
  const now = isoNow();
  const { data: existingRows, error: existingError } = await admin
    .from("terminal_hosts")
    .select("id")
    .eq("host_name", input.hostName)
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to query terminal host: ${existingError.message}`);
  }

  const payload = {
    host_name: input.hostName,
    host_type: input.hostType,
    capacity: input.capacity,
    metadata: input.metadata ?? {},
    status: input.status ?? "online",
    last_seen_at: now,
    updated_at: now,
  };

  if ((existingRows ?? []).length > 0) {
    const hostId = existingRows?.[0]?.id as string;
    const { data, error } = await admin
      .from("terminal_hosts")
      .update(payload)
      .eq("id", hostId)
      .select("*")
      .limit(1);
    if (error) {
      throw new Error(`Failed to update terminal host: ${error.message}`);
    }
    return (data ?? [])[0];
  }

  const { data, error } = await admin
    .from("terminal_hosts")
    .insert({ ...payload, created_at: now })
    .select("*")
    .limit(1);

  if (error) {
    throw new Error(`Failed to register terminal host: ${error.message}`);
  }

  return (data ?? [])[0];
}

export async function pickProvisioningHost(admin: AdminClient) {
  const { data, error } = await admin
    .from("terminal_hosts")
    .select("id, host_name, host_type, status, capacity, last_seen_at, metadata")
    .eq("status", "online")
    .order("last_seen_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`Failed to load terminal hosts: ${error.message}`);
  }

  const now = Date.now();
  const staleAfterMs = Math.max(
    45_000,
    (Number.parseFloat((process.env.TERMINAL_MANAGER_POLL_SEC ?? "10").trim()) || 10) * 3 * 1000,
  );

  return (data ?? []).find((host) => {
    const lastSeenAt = Date.parse(String(host.last_seen_at ?? ""));
    if (!Number.isFinite(lastSeenAt)) return false;
    return now - lastSeenAt <= staleAfterMs;
  }) ?? null;
}

export async function ensureActiveConfig(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("ea_user_configs")
    .select("id, connection_id, version, config_json, is_active, created_at")
    .eq("connection_id", connectionId)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load EA config: ${error.message}`);
  }

  const existing = (data ?? [])[0];
  if (existing) {
    return existing;
  }

  const now = isoNow();
  const symbols = (process.env.IFX_DEFAULT_ACTIVE_SYMBOLS
    ?? "EURUSDm,XAUUSDm,USDJPYm,AUDUSDm,USOILm,GBPUSDm")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);
  const { data: inserted, error: insertError } = await admin
    .from("ea_user_configs")
    .insert({
      connection_id: connectionId,
      version: 1,
      config_json: buildDefaultEaConfig(connectionId, {
        activeSymbols: symbols,
        releaseChannel: DEFAULT_RELEASE_CHANNEL,
        expectedEaVersion: DEFAULT_EA_VERSION,
        publishedAt: now,
        migrationSource: "default-bootstrap",
      }),
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("id, connection_id, version, config_json, is_active, created_at")
    .limit(1);

  if (insertError) {
    throw new Error(`Failed to create default EA config: ${insertError.message}`);
  }

  return (inserted ?? [])[0];
}

async function loadActiveAssignment(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("terminal_assignments")
    .select("id, release_channel, status, assigned_at")
    .eq("connection_id", connectionId)
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load terminal assignment: ${error.message}`);
  }

  return (data ?? [])[0] ?? null;
}

async function loadUserTerminalSettings(admin: AdminClient, userId: string) {
  const { data, error } = await admin
    .from("user_terminal_settings")
    .select("preferences_json, terms_version, terms_accepted_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("relation") || message.includes("schema cache")) {
      return null;
    }
    throw new Error(`Failed to load terminal settings: ${error.message}`);
  }

  return data ?? null;
}

async function loadUserStrategy(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("user_strategies")
    .select("risk_percent, max_daily_trades, max_open_trades, rr_min, rr_max, updated_at")
    .eq("connection_id", connectionId)
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("relation") || message.includes("schema cache")) {
      return null;
    }
    throw new Error(`Failed to load user strategy: ${error.message}`);
  }

  return data ?? null;
}

async function loadLatestTradingSetup(admin: AdminClient, connectionId: string) {
  const { data, error } = await admin
    .from("trading_setups")
    .select("id, symbol, side, entry_price, pivot, tp1, tp2, bias, ai_text, atr_zone_pct, sl_pad_mult, zone_percent, timeframe, ai_sensitivity, trade_now_active, use_auto_rr, auto_rr1, auto_rr2, updated_at")
    .eq("connection_id", connectionId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("relation") || message.includes("schema cache")) {
      return null;
    }
    throw new Error(`Failed to load trading setup: ${error.message}`);
  }

  return (data ?? [])[0] ?? null;
}

export async function assertConnectionOwnership(admin: AdminClient, userId: string, connectionId: string) {
  const connection = await loadConnection(admin, connectionId);
  if (!connection || String(connection.user_id) !== userId) {
    throw new Error("Connection not found or not authorized.");
  }
  return connection;
}

function buildSessionsPayload(raw: unknown, prefs?: Record<string, unknown>) {
  const sessions = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    asia: {
      enabled: Boolean(sessions.asia ?? false),
      start: typeof prefs?.asiaStart === "string" && prefs.asiaStart ? prefs.asiaStart : "19:00",
      end: typeof prefs?.asiaEnd === "string" && prefs.asiaEnd ? prefs.asiaEnd : "03:00",
    },
    london: {
      enabled: Boolean(sessions.london ?? true),
      start: typeof prefs?.londonStart === "string" && prefs.londonStart ? prefs.londonStart : "03:00",
      end: typeof prefs?.londonEnd === "string" && prefs.londonEnd ? prefs.londonEnd : "11:00",
    },
    new_york: {
      enabled: Boolean(sessions.newYork ?? sessions.new_york ?? true),
      start: typeof prefs?.nyStart === "string" && prefs.nyStart ? prefs.nyStart : "08:00",
      end: typeof prefs?.nyEnd === "string" && prefs.nyEnd ? prefs.nyEnd : "17:00",
    },
  };
}

function readBooleanPref(raw: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof raw[key] === "boolean") return raw[key] as boolean;
  }
  return undefined;
}

function readNumberPref(raw: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) return raw[key] as number;
  }
  return undefined;
}

function readStringPref(raw: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof raw[key] === "string" && raw[key].trim()) return raw[key].trim();
  }
  return undefined;
}

export async function buildEaConfigForConnection(admin: AdminClient, connectionId: string) {
  const connection = await loadConnection(admin, connectionId);
  if (!connection) {
    throw new Error("Connection not found.");
  }

  const [current, assignment, settings, strategy, setup] = await Promise.all([
    ensureActiveConfig(admin, connectionId),
    loadActiveAssignment(admin, connectionId),
    loadUserTerminalSettings(admin, String(connection.user_id)),
    loadUserStrategy(admin, connectionId),
    loadLatestTradingSetup(admin, connectionId),
  ]);

  const release = await getReleaseManifest(admin, assignment?.release_channel ?? undefined);
  const prefs = ((settings?.preferences_json as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const currentConfig = normalizeEaConfig(current.config_json, connectionId, {
    releaseChannel: String(release.channel ?? DEFAULT_RELEASE_CHANNEL),
    expectedEaVersion: String(release.version ?? DEFAULT_EA_VERSION),
    publishedAt: String(current.created_at ?? isoNow()),
  });

  const nextConfig = normalizeEaConfig(
    {
      ...currentConfig,
      meta: {
        ...currentConfig.meta,
        release_channel: String(release.channel ?? DEFAULT_RELEASE_CHANNEL),
        expected_ea_version: String(release.version ?? DEFAULT_EA_VERSION),
        published_at: isoNow(),
        migration_source: "frontend-save",
      },
      trading: {
        ...currentConfig.trading,
        enabled: Boolean(settings?.terms_version),
      },
      symbols: {
        ...currentConfig.symbols,
        active: setup?.symbol ? [String(setup.symbol)] : currentConfig.symbols.active,
        high_priority: setup?.symbol ? [String(setup.symbol)] : currentConfig.symbols.high_priority,
      },
      setup: {
        ...currentConfig.setup,
        ai_text: typeof setup?.ai_text === "string" ? setup.ai_text : currentConfig.setup.ai_text,
        bias: (setup?.bias === "buy" || setup?.bias === "sell" || setup?.bias === "neutral")
          ? setup.bias
          : (setup?.side === "buy" || setup?.side === "sell")
            ? setup.side
            : currentConfig.setup.bias,
        pivot: typeof setup?.pivot === "number" ? setup.pivot : currentConfig.setup.pivot,
        tp1: typeof setup?.tp1 === "number" ? setup.tp1 : currentConfig.setup.tp1,
        tp2: typeof setup?.tp2 === "number" ? setup.tp2 : currentConfig.setup.tp2,
        atr_zone_thickness_pct: typeof setup?.atr_zone_pct === "number"
          ? setup.atr_zone_pct
          : typeof setup?.zone_percent === "number"
            ? setup.zone_percent
            : currentConfig.setup.atr_zone_thickness_pct,
      },
      structure: {
        ...currentConfig.structure,
        timeframe: readStringPref(prefs, "engineTf", "engine_tf") ?? (typeof setup?.timeframe === "string" && setup.timeframe.trim() ? setup.timeframe.trim() : currentConfig.structure.timeframe),
        boss_timeframe: readStringPref(prefs, "bossTimeframe", "boss_timeframe") ?? currentConfig.structure.boss_timeframe,
        sl_timeframe: readStringPref(prefs, "slTimeframe", "sl_timeframe") ?? currentConfig.structure.sl_timeframe,
        be_timeframe: readStringPref(prefs, "beTimeframe", "be_timeframe") ?? currentConfig.structure.be_timeframe,
        pivot_window: typeof setup?.ai_sensitivity === "number" ? setup.ai_sensitivity : currentConfig.structure.pivot_window,
      },
      risk: {
        ...currentConfig.risk,
        risk_percent: typeof strategy?.risk_percent === "number"
          ? strategy.risk_percent
          : typeof prefs.riskPercent === "number"
            ? prefs.riskPercent
            : currentConfig.risk.risk_percent,
        min_rr: typeof strategy?.rr_min === "number"
          ? strategy.rr_min
          : currentConfig.risk.min_rr,
        strict_risk: readBooleanPref(prefs, "strictRisk", "strict_risk") ?? currentConfig.risk.strict_risk,
        max_open_trades: typeof strategy?.max_open_trades === "number"
          ? strategy.max_open_trades
          : currentConfig.risk.max_open_trades,
        max_daily_trades: typeof strategy?.max_daily_trades === "number"
          ? strategy.max_daily_trades
          : typeof prefs.maxTradesPerDay === "number"
            ? prefs.maxTradesPerDay
            : currentConfig.risk.max_daily_trades,
        max_daily_loss_usd: typeof prefs.dailyLossLimitUsd === "number"
          ? prefs.dailyLossLimitUsd
          : currentConfig.risk.max_daily_loss_usd,
        max_position_size_lots: typeof prefs.maxPositionSizeLots === "number"
          ? prefs.maxPositionSizeLots
          : currentConfig.risk.max_position_size_lots,
        min_confidence: readNumberPref(prefs, "minConfidence", "min_confidence") ?? currentConfig.risk.min_confidence,
      },
      sessions: buildSessionsPayload(prefs.sessions, prefs),
      execution: {
        ...currentConfig.execution,
        allow_market_orders: readBooleanPref(prefs, "allowMarketOrders", "allow_market_orders") ?? currentConfig.execution.allow_market_orders,
        sl_pad_mult: typeof setup?.sl_pad_mult === "number"
          ? setup.sl_pad_mult
          : currentConfig.execution.sl_pad_mult,
        use_mtf_sl: readBooleanPref(prefs, "useMtfSl", "use_mtf_sl") ?? currentConfig.execution.use_mtf_sl,
        use_dead_sl: readBooleanPref(prefs, "useDeadSl", "use_dead_sl") ?? currentConfig.execution.use_dead_sl,
        sl_cooldown_min: readNumberPref(prefs, "slCooldownMin", "sl_cooldown_min") ?? currentConfig.execution.sl_cooldown_min,
        base_magic: readNumberPref(prefs, "baseMagic", "base_magic") ?? currentConfig.execution.base_magic,
        partial_take_profit_enabled: readBooleanPref(prefs, "partialTakeProfitEnabled", "partial_take_profit_enabled") ?? currentConfig.execution.partial_take_profit_enabled,
        tp1_pct: readNumberPref(prefs, "tp1Pct", "tp1_pct") ?? currentConfig.execution.tp1_pct,
        break_even_enabled: readBooleanPref(prefs, "breakEvenEnabled", "break_even_enabled") ?? currentConfig.execution.break_even_enabled,
        break_even_after_tp1: readBooleanPref(prefs, "breakEvenAfterTp1", "break_even_after_tp1") ?? currentConfig.execution.break_even_after_tp1,
        use_auto_rr: typeof setup?.use_auto_rr === "boolean"
          ? setup.use_auto_rr
          : currentConfig.execution.use_auto_rr,
        auto_rr1: typeof setup?.auto_rr1 === "number"
          ? setup.auto_rr1
          : currentConfig.execution.auto_rr1,
        auto_rr2: typeof setup?.auto_rr2 === "number"
          ? setup.auto_rr2
          : currentConfig.execution.auto_rr2,
        close_eod: readBooleanPref(prefs, "closeEod", "close_eod") ?? currentConfig.execution.close_eod,
        eod_time: readStringPref(prefs, "eodTime", "eod_time") ?? currentConfig.execution.eod_time,
        exit_on_flip: readBooleanPref(prefs, "exitOnFlip", "exit_on_flip") ?? currentConfig.execution.exit_on_flip,
      },
      visuals: {
        ...currentConfig.visuals,
        show_struct: readBooleanPref(prefs, "showStruct", "show_struct") ?? currentConfig.visuals.show_struct,
        smc_lookback: readNumberPref(prefs, "smcLookback", "smc_lookback") ?? currentConfig.visuals.smc_lookback,
      },
      discord: {
        ...currentConfig.discord,
        webhook_url: readStringPref(prefs, "discordWebhookUrl", "discord_webhook_url") ?? currentConfig.discord.webhook_url,
        enable_discord: readBooleanPref(prefs, "enableDiscord", "enable_discord") ?? currentConfig.discord.enable_discord,
        notify_on_sl: readBooleanPref(prefs, "notifyOnSL", "notify_on_sl") ?? currentConfig.discord.notify_on_sl,
        notify_on_tp: readBooleanPref(prefs, "notifyOnTP", "notify_on_tp") ?? currentConfig.discord.notify_on_tp,
        notify_daily: readBooleanPref(prefs, "notifyDaily", "notify_daily") ?? currentConfig.discord.notify_daily,
      },
    },
    connectionId,
    {
      releaseChannel: String(release.channel ?? DEFAULT_RELEASE_CHANNEL),
      expectedEaVersion: String(release.version ?? DEFAULT_EA_VERSION),
      publishedAt: isoNow(),
      migrationSource: "frontend-save",
    },
  );

  return { current, nextConfig };
}

export async function publishEaConfigForConnection(admin: AdminClient, connectionId: string) {
  const { current, nextConfig } = await buildEaConfigForConnection(admin, connectionId);
  const normalizedCurrent = normalizeEaConfig(current.config_json, connectionId, {
    releaseChannel: nextConfig.meta.release_channel,
    expectedEaVersion: nextConfig.meta.expected_ea_version,
    publishedAt: String(current.created_at ?? isoNow()),
  });

  if (JSON.stringify(normalizedCurrent) === JSON.stringify(nextConfig)) {
    return { changed: false, row: { ...current, config_json: normalizedCurrent } };
  }

  const now = isoNow();
  const nextVersion = Number(current.version ?? 0) + 1;
  const { error: deactivateError } = await admin
    .from("ea_user_configs")
    .update({ is_active: false, updated_at: now })
    .eq("id", current.id);

  if (deactivateError) {
    throw new Error(`Failed to retire previous EA config: ${deactivateError.message}`);
  }

  const { data, error } = await admin
    .from("ea_user_configs")
    .insert({
      connection_id: connectionId,
      version: nextVersion,
      config_json: nextConfig,
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("id, connection_id, version, config_json, is_active, created_at")
    .limit(1);

  if (error) {
    throw new Error(`Failed to publish EA config: ${error.message}`);
  }

  return { changed: true, row: (data ?? [])[0] ?? null };
}

export async function getConnectionExecutionMode(admin: AdminClient, connectionId: string): Promise<EaExecutionMode> {
  const config = await ensureActiveConfig(admin, connectionId);
  return normalizeEaConfig(config.config_json, connectionId).trading.execution_mode;
}

export async function setConnectionExecutionMode(admin: AdminClient, connectionId: string, mode: EaExecutionMode) {
  const current = await ensureActiveConfig(admin, connectionId);
  const normalizedCurrent = normalizeEaConfig(current.config_json, connectionId, {
    publishedAt: String(current.created_at ?? isoNow()),
  });

  if (normalizedCurrent.trading.execution_mode === mode) {
    return { changed: false, row: { ...current, config_json: normalizedCurrent } };
  }

  const now = isoNow();
  const nextVersion = Number(current.version ?? 0) + 1;
  const nextConfig = {
    ...normalizedCurrent,
    meta: {
      ...normalizedCurrent.meta,
      published_at: now,
      migration_source: "execution-mode-toggle",
    },
    trading: {
      ...normalizedCurrent.trading,
      execution_mode: mode,
    },
  };

  const { error: deactivateError } = await admin
    .from("ea_user_configs")
    .update({ is_active: false, updated_at: now })
    .eq("id", current.id);

  if (deactivateError) {
    throw new Error(`Failed to retire previous EA config: ${deactivateError.message}`);
  }

  const { data, error } = await admin
    .from("ea_user_configs")
    .insert({
      connection_id: connectionId,
      version: nextVersion,
      config_json: nextConfig,
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("id, connection_id, version, config_json, is_active, created_at")
    .limit(1);

  if (error) {
    throw new Error(`Failed to set execution mode: ${error.message}`);
  }

  return { changed: true, row: (data ?? [])[0] ?? null };
}

export async function patchEaConfigVisuals(
  admin: AdminClient,
  connectionId: string,
  patch: { show_struct?: boolean; smc_lookback?: number },
) {
  const current = await ensureActiveConfig(admin, connectionId);
  const normalizedCurrent = normalizeEaConfig(current.config_json, connectionId, {
    publishedAt: String(current.created_at ?? isoNow()),
  });

  const now = isoNow();
  const nextVersion = Number(current.version ?? 0) + 1;
  const nextConfig = {
    ...normalizedCurrent,
    meta: { ...normalizedCurrent.meta, published_at: now, migration_source: "visuals-patch" },
    visuals: {
      ...normalizedCurrent.visuals,
      ...(patch.show_struct !== undefined ? { show_struct: patch.show_struct } : {}),
      ...(patch.smc_lookback !== undefined ? { smc_lookback: patch.smc_lookback } : {}),
    },
  };

  const { error: deactivateError } = await admin
    .from("ea_user_configs")
    .update({ is_active: false, updated_at: now })
    .eq("id", current.id);

  if (deactivateError) {
    throw new Error(`Failed to retire previous EA config: ${deactivateError.message}`);
  }

  const { data, error } = await admin
    .from("ea_user_configs")
    .insert({
      connection_id: connectionId,
      version: nextVersion,
      config_json: nextConfig,
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("id, connection_id, version, config_json, is_active, created_at")
    .limit(1);

  if (error) {
    throw new Error(`Failed to patch EA visuals config: ${error.message}`);
  }

  return { changed: true, row: (data ?? [])[0] ?? null };
}

export async function enqueueEaCommand(
  admin: AdminClient,
  input: {
    connectionId: string;
    userId: string;
    commandType: EaCommandType;
    payloadJson?: JsonMap;
    idempotencyKey?: string;
    expiresAt?: string | null;
  },
) {
  const { data: latestRows, error: latestError } = await admin
    .from("ea_commands")
    .select("sequence_no")
    .eq("connection_id", input.connectionId)
    .order("sequence_no", { ascending: false })
    .limit(1);

  if (latestError) {
    throw new Error(`Failed to load EA command cursor: ${latestError.message}`);
  }

  const nextSequence = Number((latestRows ?? [])[0]?.sequence_no ?? 0) + 1;
  const now = isoNow();
  const { data, error } = await admin
    .from("ea_commands")
    .insert({
      connection_id: input.connectionId,
      user_id: input.userId,
      command_type: input.commandType,
      payload_json: input.payloadJson ?? {},
      sequence_no: nextSequence,
      idempotency_key: input.idempotencyKey ?? `${input.connectionId}:${input.commandType}:${randomUUID()}`,
      status: "pending",
      expires_at: input.expiresAt ?? null,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .limit(1);

  if (error) {
    throw new Error(`Failed to enqueue EA command: ${error.message}`);
  }

  return (data ?? [])[0] ?? null;
}

export async function getReleaseManifest(admin: AdminClient, channel?: string) {
  const effectiveChannel = (channel ?? DEFAULT_RELEASE_CHANNEL).trim() || DEFAULT_RELEASE_CHANNEL;

  const { data, error } = await admin
    .from("ea_releases")
    .select("id, version, channel, artifact_url, sha256, metadata_json, is_active, created_at")
    .eq("channel", effectiveChannel)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to load EA release manifest: ${error.message}`);
  }

  const latest = (data ?? [])[0];
  if (latest) {
    return latest;
  }

  return {
    id: null,
    version: DEFAULT_EA_VERSION,
    channel: effectiveChannel,
    artifact_url: DEFAULT_EA_ARTIFACT_URL,
    sha256: DEFAULT_EA_SHA256,
    metadata_json: {
      source: "env-fallback",
    },
    is_active: true,
    created_at: isoNow(),
  };
}

async function connectionRuntimeSignalFresh(admin: AdminClient, connectionId: string) {
  const freshAfterSec = Math.max(
    60,
    Number.parseInt((process.env.TERMINAL_ASSIGNMENT_STALE_SIGNAL_SEC ?? "120").trim(), 10) || 120,
  );
  const cutoffMs = Date.now() - freshAfterSec * 1000;

  const [heartbeatResult, installationResult] = await Promise.all([
    admin
      .from("mt5_worker_heartbeats")
      .select("last_seen_at,status,mt5_initialized")
      .eq("connection_id", connectionId)
      .order("last_seen_at", { ascending: false })
      .limit(1),
    admin
      .from("ea_installations")
      .select("last_seen_at,status")
      .eq("connection_id", connectionId)
      .order("last_seen_at", { ascending: false })
      .limit(1),
  ]);

  if (heartbeatResult.error) {
    throw new Error(`Failed to load worker heartbeat: ${heartbeatResult.error.message}`);
  }
  if (installationResult.error) {
    throw new Error(`Failed to load EA installation heartbeat: ${installationResult.error.message}`);
  }

  const heartbeat = (heartbeatResult.data ?? [])[0] as { last_seen_at?: string; status?: string; mt5_initialized?: boolean } | undefined;
  const installation = (installationResult.data ?? [])[0] as { last_seen_at?: string; status?: string } | undefined;

  const heartbeatSeenAt = Date.parse(String(heartbeat?.last_seen_at ?? ""));
  const installSeenAt = Date.parse(String(installation?.last_seen_at ?? ""));

  const heartbeatFresh = Number.isFinite(heartbeatSeenAt)
    && heartbeatSeenAt >= cutoffMs
    && String(heartbeat?.status ?? "").toLowerCase() !== "error"
    && Boolean(heartbeat?.mt5_initialized);
  const installationFresh = Number.isFinite(installSeenAt)
    && installSeenAt >= cutoffMs
    && ["online", "starting"].includes(String(installation?.status ?? "").toLowerCase());

  return heartbeatFresh || installationFresh;
}

export async function ensureBootstrapAssignment(
  admin: AdminClient,
  input: {
    connectionId: string;
    hostId: string;
    releaseChannel?: string;
  },
) {
  const now = isoNow();
  const effectiveChannel = (input.releaseChannel ?? DEFAULT_RELEASE_CHANNEL).trim() || DEFAULT_RELEASE_CHANNEL;

  const { data: existingRows, error: existingError } = await admin
    .from("terminal_assignments")
    .select("*")
    .eq("connection_id", input.connectionId)
    .eq("host_id", input.hostId)
    .in("status", ["pending", "provisioning", "launched", "active"])
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to load terminal assignment: ${existingError.message}`);
  }

  const existing = (existingRows ?? [])[0];
  if (existing) {
    if (["launched", "active"].includes(String(existing.status ?? ""))) {
      const signalFresh = await connectionRuntimeSignalFresh(admin, input.connectionId);
      if (!signalFresh) {
        const { data: requeuedRows, error: requeueError } = await admin
          .from("terminal_assignments")
          .update({
            status: "pending",
            assigned_at: now,
            updated_at: now,
            last_error: "Requeued by bootstrap because no fresh terminal or EA heartbeat was present.",
          })
          .eq("id", existing.id)
          .select("*")
          .limit(1);

        if (requeueError) {
          throw new Error(`Failed to requeue stale terminal assignment: ${requeueError.message}`);
        }

        return (requeuedRows ?? [])[0] ?? existing;
      }
    }

    return existing;
  }

  const { data, error } = await admin
    .from("terminal_assignments")
    .insert({
      connection_id: input.connectionId,
      host_id: input.hostId,
      status: "pending",
      install_token: generateInstallToken(),
      release_channel: effectiveChannel,
      assigned_at: now,
      updated_at: now,
    })
    .select("*")
    .limit(1);

  if (error) {
    throw new Error(`Failed to create terminal assignment: ${error.message}`);
  }

  return (data ?? [])[0];
}

export async function verifyEaAccess(admin: AdminClient, connectionId: string, installToken: string) {
  const { data: installationRows, error: installationError } = await admin
    .from("ea_installations")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("install_token", installToken)
    .order("created_at", { ascending: false })
    .limit(1);

  if (installationError) {
    throw new Error(`Failed to verify EA installation: ${installationError.message}`);
  }

  const installation = (installationRows ?? [])[0];
  if (installation) {
    return { kind: "installation" as const, installation };
  }

  const { data: assignmentRows, error: assignmentError } = await admin
    .from("terminal_assignments")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("install_token", installToken)
    .order("assigned_at", { ascending: false })
    .limit(1);

  if (assignmentError) {
    throw new Error(`Failed to verify EA assignment: ${assignmentError.message}`);
  }

  const assignment = (assignmentRows ?? [])[0];
  if (!assignment) {
    return null;
  }

  return { kind: "assignment" as const, assignment };
}

export function extractInstallToken(req: NextRequest) {
  const headerToken = (req.headers.get("x-ifx-install-token") ?? "").trim();
  if (headerToken) {
    return headerToken;
  }

  const bearer = extractBearer(req);
  if (bearer) {
    return bearer;
  }

  return "";
}

export async function requireEaAuth(req: NextRequest, connectionId: string) {
  const token = extractInstallToken(req);
  if (!token) {
    return { error: unauthorized("install token required"), admin: null, access: null, token: "" };
  }

  const admin = createAdminClient();
  const access = await verifyEaAccess(admin, connectionId, token);
  if (!access) {
    return { error: unauthorized("invalid install token"), admin: null, access: null, token };
  }

  return { error: null, admin, access, token };
}
