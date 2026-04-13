"use server";

import { createAdminClient } from "@/utils/supabase/admin";
import { assertConnectionOwnership, enqueueEaCommand, getConnectionExecutionMode, patchEaConfigVisuals, publishEaConfigForConnection, setConnectionExecutionMode } from "@/lib/ea-control-plane";
import { createClient } from "@/utils/supabase/server";
import type { EaExecutionMode } from "@/lib/ea-config";
import type { PersistedTerminalSettings, TerminalPreferences } from "@/app/terminal/types";

export async function saveTerminalSettings(input: {
  preferences: TerminalPreferences;
  termsVersion: string | null;
  termsAccepted: boolean;
  connectionId?: string | null;
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

  const connectionId = (input.connectionId ?? "").trim();
  if (connectionId) {
    const admin = createAdminClient();
    await assertConnectionOwnership(admin, user.id, connectionId);
    await publishEaConfigForConnection(admin, connectionId);
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

export async function getConnectionExecutionModeAction(connectionId: string): Promise<EaExecutionMode> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Unauthorized");

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, connectionId);
  return getConnectionExecutionMode(admin, connectionId);
}

export async function saveConnectionExecutionMode(input: { connectionId: string; executionMode: EaExecutionMode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Unauthorized");

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, input.connectionId);
  const result = await setConnectionExecutionMode(admin, input.connectionId, input.executionMode);

  if (input.executionMode === "ea-first") {
    await enqueueEaCommand(admin, {
      connectionId: input.connectionId,
      userId: user.id,
      commandType: "sync_config",
      payloadJson: { reason: "execution_mode_changed", execution_mode: input.executionMode },
      idempotencyKey: `sync_config:${input.connectionId}:${Date.now()}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
  }

  return { ok: true as const, changed: result.changed, executionMode: input.executionMode };
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

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, input.connectionId);
  const executionMode = await getConnectionExecutionMode(admin, input.connectionId);

  if (executionMode === "ea-first") {
    const command = await enqueueEaCommand(admin, {
      connectionId: input.connectionId,
      userId: user.id,
      commandType: "close_position",
      payloadJson: {
        ticket: input.ticket,
        symbol: input.symbol,
        volume: input.volume,
        side: input.side,
      },
      idempotencyKey: `close:${input.connectionId}:${input.ticket}`,
    });

    return { ok: true as const, commandId: String(command?.id ?? "") };
  }

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

export async function patchEaVisuals(input: {
  connectionId: string;
  showStruct: boolean;
  smcLookback: number;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error("Unauthorized");

  const admin = createAdminClient();
  await assertConnectionOwnership(admin, user.id, input.connectionId);

  await patchEaConfigVisuals(admin, input.connectionId, {
    show_struct: input.showStruct,
    smc_lookback: Math.min(Math.max(Math.round(input.smcLookback), 50), 5000),
  });

  await publishEaConfigForConnection(admin, input.connectionId);
  return { ok: true as const };
}
