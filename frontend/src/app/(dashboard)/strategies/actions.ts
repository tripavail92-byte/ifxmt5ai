"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { assertConnectionOwnership, enqueueEaCommand, getConnectionExecutionMode, publishEaConfigForConnection } from "@/lib/ea-control-plane";

const TERMINAL_TERMS_VERSION = "2026-03-28-v1";

// ─── Session UTC hour windows ────────────────────────────────────────────────
// Returns true if the current UTC time falls inside any enabled session.
// London 08:00–16:30, New York 13:00–21:00, Asia 23:00–08:00 (next day)
function isWithinEnabledSession(sessions: { london?: boolean; newYork?: boolean; asia?: boolean } | undefined): boolean {
  if (!sessions) return true; // no pref stored → allow
  if (!sessions.london && !sessions.newYork && !sessions.asia) return false; // all off

  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;

  if (sessions.london && utcHour >= 8 && utcHour < 16.5) return true;
  if (sessions.newYork && utcHour >= 13 && utcHour < 21) return true;
  if (sessions.asia && (utcHour >= 23 || utcHour < 8)) return true;

  return false; // inside a disabled session window
}

async function enforceTerminalExecutionGuards(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  connectionId: string,
  tradeVolume?: number, // optional — checked against maxPositionSizeLots
) {
  const { data: settings, error } = await supabase
    .from("user_terminal_settings")
    .select("preferences_json, terms_version")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (!(message.includes("does not exist") || message.includes("relation") || message.includes("schema cache"))) {
      throw new Error(`Failed to validate terminal settings: ${error.message}`);
    }
    return; // table missing → skip enforcement gracefully
  }

  if (!settings || settings.terms_version !== TERMINAL_TERMS_VERSION) {
    throw new Error("Accept the current terminal terms before queueing live MT5 execution.");
  }

  const prefs = (settings.preferences_json ?? {}) as {
    maxTradesPerDay?: number;
    maxPositionSizeLots?: number;
    dailyLossLimitUsd?: number;
    dailyProfitTargetUsd?: number;
    maxDrawdownPercent?: number;
    sessions?: { london?: boolean; newYork?: boolean; asia?: boolean };
  };

  // --- 1. Max trades / day ---
  const maxTradesPerDay = Number(prefs.maxTradesPerDay ?? 0);
  if (maxTradesPerDay > 0) {
    const { data: dailyTrades, error: dailyErr } = await supabase.rpc("count_daily_trades", { p_connection_id: connectionId });
    if (dailyErr) throw new Error(`Failed to validate daily trade limit: ${dailyErr.message}`);
    if (Number(dailyTrades ?? 0) >= maxTradesPerDay) {
      throw new Error(`Daily trade limit reached: ${Number(dailyTrades ?? 0)}/${maxTradesPerDay}`);
    }
  }

  // --- 2. Session window enforcement ---
  if (!isWithinEnabledSession(prefs.sessions)) {
    throw new Error("No enabled trading session is currently active. Enable a session or wait for your session window.");
  }

  // --- 3. Max position size ---
  const maxPositionSizeLots = Number(prefs.maxPositionSizeLots ?? 0);
  if (maxPositionSizeLots > 0 && tradeVolume && tradeVolume > maxPositionSizeLots) {
    throw new Error(`Trade volume ${tradeVolume} lots exceeds your max position size of ${maxPositionSizeLots} lots.`);
  }

  // --- 4. Daily loss limit + daily profit target + max drawdown ---
  // All three are checked against the live heartbeat metrics.
  const dailyLossLimitUsd = Number(prefs.dailyLossLimitUsd ?? 0);
  const dailyProfitTargetUsd = Number(prefs.dailyProfitTargetUsd ?? 0);
  const maxDrawdownPercent = Number(prefs.maxDrawdownPercent ?? 0);

  const needsHeartbeat = dailyLossLimitUsd > 0 || dailyProfitTargetUsd > 0 || maxDrawdownPercent > 0;
  if (needsHeartbeat) {
    const { data: hb } = await supabase
      .from("mt5_worker_heartbeats")
      .select("last_metrics")
      .eq("connection_id", connectionId)
      .maybeSingle();

    if (hb?.last_metrics) {
      const metrics = hb.last_metrics as { balance?: number; equity?: number; profit?: number };
      const balance = Number(metrics.balance ?? 0);
      const equity = Number(metrics.equity ?? 0);
      const floatingProfit = Number(metrics.profit ?? 0);

      if (dailyLossLimitUsd > 0 && floatingProfit < -dailyLossLimitUsd) {
        throw new Error(`Daily loss limit of $${dailyLossLimitUsd} reached (floating P&L: $${floatingProfit.toFixed(2)}).`);
      }
      if (dailyProfitTargetUsd > 0 && floatingProfit >= dailyProfitTargetUsd) {
        throw new Error(`Daily profit target of $${dailyProfitTargetUsd} reached — new trades are locked for today.`);
      }
      if (maxDrawdownPercent > 0 && balance > 0) {
        const drawdown = ((balance - equity) / balance) * 100;
        if (drawdown >= maxDrawdownPercent) {
          throw new Error(`Max drawdown of ${maxDrawdownPercent}% reached (current: ${drawdown.toFixed(1)}%).`);
        }
      }
    }
  }
}

export async function saveStrategy(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const connection_id = formData.get("connection_id") as string;
  const risk_percent = parseFloat(formData.get("risk_percent") as string);
  const max_daily_trades = parseInt(formData.get("max_daily_trades") as string, 10);
  const max_open_trades = parseInt(formData.get("max_open_trades") as string, 10);
  const rr_min = parseFloat(formData.get("rr_min") as string);
  const rr_max = parseFloat(formData.get("rr_max") as string);

  const { error } = await supabase.from("user_strategies").upsert(
    {
      user_id: user.id,
      connection_id,
      risk_percent,
      max_daily_trades,
      max_open_trades,
      rr_min,
      rr_max,
      is_active: true,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'connection_id' }
  );

  if (error) throw new Error("Failed to save strategy. Check logs.");
  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, connection_id);
  await publishEaConfigForConnection(admin, connection_id);
  revalidatePath("/strategies");
}

export async function saveTrackedSetup(params: {
  connection_id: string;
  symbol: string;
  side: string;
  entry_price: number;
  zone_percent: number;
  timeframe: string;
  ai_sensitivity: number;
  trade_plan_notes?: string | null;
  setup_id?: string | null;
  // v9.30 fields
  pivot?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  bias?: string | null;
  atr_zone_pct?: number | null;
  sl_pad_mult?: number | null;
}): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const payloadV2 = {
    p_user_id: user.id,
    p_connection_id: params.connection_id,
    p_symbol: params.symbol,
    p_side: params.side,
    p_entry_price: params.entry_price,
    p_zone_percent: params.zone_percent,
    p_timeframe: params.timeframe,
    p_ai_sensitivity: params.ai_sensitivity,
    p_notes: params.trade_plan_notes ?? null,
    p_setup_id: params.setup_id ?? null,
  };

  let { data: newId, error: upsertErr } = await supabase.rpc("upsert_trading_setup", payloadV2);
  if (upsertErr) {
    const msg = String((upsertErr as { message?: unknown })?.message ?? upsertErr);
    if (msg.toLowerCase().includes("p_ai_sensitivity") || msg.toLowerCase().includes("p_notes") || msg.toLowerCase().includes("function")) {
      const payloadV1 = { ...payloadV2 } as Record<string, unknown>;
      delete payloadV1.p_ai_sensitivity;
      delete payloadV1.p_notes;
      ({ data: newId, error: upsertErr } = await supabase.rpc("upsert_trading_setup", payloadV1));
    }
  }

  if (upsertErr) throw new Error(upsertErr.message);

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, params.connection_id);

  // Patch v9.30 fields onto the setup row (non-breaking — columns added by phase1 migration)
  const v930Patch: Record<string, unknown> = {};
  if (params.pivot != null)        v930Patch.pivot        = params.pivot;
  if (params.tp1 != null)          v930Patch.tp1          = params.tp1;
  if (params.tp2 != null)          v930Patch.tp2          = params.tp2;
  if (params.bias != null)         v930Patch.bias         = params.bias;
  if (params.atr_zone_pct != null) v930Patch.atr_zone_pct = params.atr_zone_pct;
  if (params.sl_pad_mult != null)  v930Patch.sl_pad_mult  = params.sl_pad_mult;

  if (Object.keys(v930Patch).length > 0) {
    const service = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    await service.from("trading_setups").update(v930Patch).eq("id", String(newId));
  }

  await publishEaConfigForConnection(admin, params.connection_id);

  return String(newId);
}

export async function placeManualTrade(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const connection_id = formData.get("connection_id") as string;
  const symbol = (formData.get("symbol") as string).trim().toUpperCase();
  const side = formData.get("side") as string;
  const volume = parseFloat(formData.get("volume") as string);
  const sl_raw = parseFloat(formData.get("sl") as string);
  const tp_raw = parseFloat(formData.get("tp") as string);
  const comment = ((formData.get("comment") as string | null) ?? "").trim();

  if (!connection_id || !symbol || !side || !volume) {
    throw new Error("Missing required fields.");
  }

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, connection_id);
  const executionMode = await getConnectionExecutionMode(admin, connection_id);

  // Verify this connection belongs to the current user (via RLS)
  const { data: conn } = await supabase
    .from("mt5_user_connections")
    .select("id")
    .eq("id", connection_id)
    .single();
  if (!conn) throw new Error("Connection not found or not authorized.");

  await enforceTerminalExecutionGuards(supabase, user.id, connection_id, volume);

  if (executionMode === "ea-first") {
    await enqueueEaCommand(admin, {
      connectionId: connection_id,
      userId: user.id,
      commandType: "manual_trade",
      payloadJson: {
        symbol,
        side,
        volume,
        sl: isNaN(sl_raw) ? null : sl_raw,
        tp: isNaN(tp_raw) ? null : tp_raw,
        comment: comment || null,
      },
      idempotencyKey: `${connection_id}:manual_trade:${symbol}:${Date.now()}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    revalidatePath("/trades");
    revalidatePath("/strategies");
    return;
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await service.from("trade_jobs").insert({
    connection_id,
    symbol,
    side,
    volume,
    sl: isNaN(sl_raw) ? null : sl_raw,
    tp: isNaN(tp_raw) ? null : tp_raw,
    ...(comment ? { comment } : {}),
    idempotency_key: `${connection_id}:${Date.now()}:${crypto.randomUUID()}`,
    status: "queued",
    created_at: new Date().toISOString(),
  });

  if (error) throw new Error(`Failed to queue trade: ${error.message}`);
  revalidatePath("/trades");
  revalidatePath("/strategies");
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Now: arm a setup so setup_manager fires a 0.01-lot test trade the
// moment  state == STALKING  AND  a matching CHOCH/BOS structure break fires.
// ─────────────────────────────────────────────────────────────────────────────
export async function activateTradeNow(params: {
  connection_id: string;
  symbol: string;
  side: string;
  entry_price: number;
  zone_percent: number;
  timeframe: string;
  ai_sensitivity: number;
  trade_plan_notes?: string | null;
  setup_id?: string | null;
  // v9.30 fields
  pivot?: number | null;
  tp1?: number | null;
  tp2?: number | null;
  bias?: string | null;
  atr_zone_pct?: number | null;
  sl_pad_mult?: number | null;
}): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, params.connection_id);
  const executionMode = await getConnectionExecutionMode(admin, params.connection_id);

  // 1. Upsert (or create) the trading setup row
  const { data: newId, error: upsertErr } = await supabase.rpc("upsert_trading_setup", {
    p_user_id:        user.id,
    p_connection_id:  params.connection_id,
    p_symbol:         params.symbol,
    p_side:           params.side,
    p_entry_price:    params.entry_price,
    p_zone_percent:   params.zone_percent,
    p_timeframe:      params.timeframe,
    p_ai_sensitivity: params.ai_sensitivity,
    p_notes:          params.trade_plan_notes ?? null,
    p_setup_id:       params.setup_id ?? null,
  });

  if (upsertErr) throw new Error(upsertErr.message);
  const setupId = newId as string;

  // Patch v9.30 fields onto the setup row
  const v930Patch: Record<string, unknown> = {};
  if (params.pivot != null)        v930Patch.pivot        = params.pivot;
  if (params.tp1 != null)          v930Patch.tp1          = params.tp1;
  if (params.tp2 != null)          v930Patch.tp2          = params.tp2;
  if (params.bias != null)         v930Patch.bias         = params.bias;
  if (params.atr_zone_pct != null) v930Patch.atr_zone_pct = params.atr_zone_pct;
  if (params.sl_pad_mult != null)  v930Patch.sl_pad_mult  = params.sl_pad_mult;

  if (Object.keys(v930Patch).length > 0) {
    const serviceV930 = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    await serviceV930.from("trading_setups").update(v930Patch).eq("id", setupId);
  }

  const { data: conn } = await supabase
    .from("mt5_user_connections")
    .select("id")
    .eq("id", params.connection_id)
    .single();
  if (!conn) throw new Error("Connection not found or not authorized.");

  await enforceTerminalExecutionGuards(supabase, user.id, params.connection_id);
  await publishEaConfigForConnection(admin, params.connection_id);

  if (executionMode === "ea-first") {
    await enqueueEaCommand(admin, {
      connectionId: params.connection_id,
      userId: user.id,
      commandType: "arm_trade",
      payloadJson: {
        setup_id: setupId,
        symbol: params.symbol,
        side: params.side,
        entry_price: params.entry_price,
        zone_percent: params.zone_percent,
        timeframe: params.timeframe,
        ai_sensitivity: params.ai_sensitivity,
        trade_plan_notes: params.trade_plan_notes ?? null,
        // v9.30 fields
        pivot:        params.pivot        ?? null,
        tp1:          params.tp1          ?? null,
        tp2:          params.tp2          ?? null,
        bias:         params.bias         ?? null,
        atr_zone_pct: params.atr_zone_pct ?? null,
        sl_pad_mult:  params.sl_pad_mult  ?? null,
      },
      idempotencyKey: `arm_trade:${params.connection_id}:${setupId}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });

    revalidatePath("/strategies");
    revalidatePath("/trades");
    return setupId;
  }

  // 2. Arm the Trade Now flag using service role (bypasses RLS on the update)
  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { error: flagErr } = await service
    .from("trading_setups")
    .update({ trade_now_active: true })
    .eq("id", setupId);

  if (flagErr) throw new Error(`Could not arm Trade Now: ${flagErr.message}`);

  revalidatePath("/strategies");
  revalidatePath("/trades");
  return setupId;
}
