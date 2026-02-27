"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";

export async function saveStrategy(formData: FormData) {
  const supabase = await createClient();
  
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Unauthorized");
  }

  const connection_id = formData.get("connection_id") as string;
  const risk_percent = parseFloat(formData.get("risk_percent") as string);
  const max_daily_trades = parseInt(formData.get("max_daily_trades") as string, 10);
  const max_open_trades = parseInt(formData.get("max_open_trades") as string, 10);
  const rr_min = parseFloat(formData.get("rr_min") as string);
  const rr_max = parseFloat(formData.get("rr_max") as string);

  // Upsert the strategy for this connection
  // Using connection_id as the unique constraint
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

  if (error) {
    console.error("Failed to save strategy:", error);
    throw new Error("Failed to save strategy. Check logs.");
  }

  revalidatePath("/strategies");
}
