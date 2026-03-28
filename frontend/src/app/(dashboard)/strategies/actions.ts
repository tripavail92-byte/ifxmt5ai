"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

const TERMINAL_TERMS_VERSION = "2026-03-28-v1";

async function enforceTerminalExecutionGuards(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  connectionId: string,
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
    return;
  }

  if (!settings || settings.terms_version !== TERMINAL_TERMS_VERSION) {
    throw new Error("Accept the current terminal terms before queueing live MT5 execution.");
  }

  const prefs = (settings.preferences_json ?? {}) as { maxTradesPerDay?: number; sessions?: { london?: boolean; newYork?: boolean; asia?: boolean } };
  const maxTradesPerDay = Number(prefs.maxTradesPerDay ?? 0);
  if (maxTradesPerDay > 0) {
    const { data: dailyTrades, error: dailyErr } = await supabase.rpc("count_daily_trades", { p_connection_id: connectionId });
    if (dailyErr) {
      throw new Error(`Failed to validate daily trade limit: ${dailyErr.message}`);
    }
    if (Number(dailyTrades ?? 0) >= maxTradesPerDay) {
      throw new Error(`Daily trade limit reached: ${Number(dailyTrades ?? 0)}/${maxTradesPerDay}`);
    }
  }

  const sessions = prefs.sessions;
  if (sessions && !sessions.london && !sessions.newYork && !sessions.asia) {
    throw new Error("Enable at least one trading session before queueing execution.");
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
  revalidatePath("/strategies");
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

  if (!connection_id || !symbol || !side || !volume) {
    throw new Error("Missing required fields.");
  }

  // Verify this connection belongs to the current user (via RLS)
  const { data: conn } = await supabase
    .from("mt5_user_connections")
    .select("id")
    .eq("id", connection_id)
    .single();
  if (!conn) throw new Error("Connection not found or not authorized.");

  await enforceTerminalExecutionGuards(supabase, user.id, connection_id);

  // Use service role to bypass trade_jobs RLS for the insert
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
  setup_id?: string | null;
}): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

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
    p_setup_id:       params.setup_id ?? null,
  });

  if (upsertErr) throw new Error(upsertErr.message);
  const setupId = newId as string;

  const { data: conn } = await supabase
    .from("mt5_user_connections")
    .select("id")
    .eq("id", params.connection_id)
    .single();
  if (!conn) throw new Error("Connection not found or not authorized.");

  await enforceTerminalExecutionGuards(supabase, user.id, params.connection_id);

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
