"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

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
