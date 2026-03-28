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
