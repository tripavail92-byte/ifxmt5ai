"use server";

import { createClient } from "@/utils/supabase/server";
import type { PersistedTerminalSettings, TerminalPreferences } from "@/app/terminal/types";

export async function saveTerminalSettings(input: {
  preferences: TerminalPreferences;
  termsVersion: string | null;
  termsAccepted: boolean;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  const row = {
    user_id: user.id,
    preferences_json: input.preferences,
    terms_version: input.termsAccepted ? input.termsVersion : null,
    terms_accepted_at: input.termsAccepted ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("user_terminal_settings")
    .upsert(row, { onConflict: "user_id" });

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("relation") || message.includes("schema cache")) {
      return { ok: false as const, reason: "missing_table" as const };
    }
    throw new Error(`Failed to save terminal settings: ${error.message}`);
  }

  return { ok: true as const };
}

export async function getTerminalSettings(): Promise<PersistedTerminalSettings | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("user_terminal_settings")
    .select("preferences_json, terms_version, terms_accepted_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("relation") || message.includes("schema cache")) {
      return null;
    }
    throw new Error(`Failed to load terminal settings: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  return {
    preferences: (data.preferences_json as Partial<TerminalPreferences> | null) ?? null,
    termsVersion: data.terms_version ?? null,
    termsAcceptedAt: data.terms_accepted_at ?? null,
  };
}

export async function closeTradeJob(input: {
  connectionId: string;
  ticket: number;
  symbol: string;
  volume: number;
  side: "buy" | "sell";
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Unauthorized");

  // Verify the connection belongs to this user
  const { data: conn } = await supabase
    .from("mt5_user_connections")
    .select("id")
    .eq("id", input.connectionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!conn) {
    return { ok: false as const, reason: "unauthorized_connection" as const };
  }

  // The worker handles close via comment = "__close__:<ticket>"
  // Side is set to the opposite direction (how MT5 executes a close)
  const closeSide = input.side === "buy" ? "sell" : "buy";
  const idempotencyKey = `close_${input.ticket}_${Date.now()}`;

  const { error } = await supabase.from("trade_jobs").insert({
    connection_id: input.connectionId,
    symbol: input.symbol,
    side: closeSide,
    volume: input.volume,
    comment: `__close__:${input.ticket}`,
    idempotency_key: idempotencyKey,
    status: "queued",
  });

  if (error) {
    return { ok: false as const, reason: error.message };
  }

  return { ok: true as const };
}
