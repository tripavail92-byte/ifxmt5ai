import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    hud_status?: string;
    sys_bias?: string;
    sys_pivot?: number;
    sys_tp1?: number;
    sys_tp2?: number;
    invalidation_lvl?: number;
    live_sl?: number;
    live_lots?: number;
    is_inside_zone?: boolean;
    is_be_secured?: boolean;
    unrealised_pnl?: number;
    daily_trades?: number;
    daily_pnl_usd?: number;
    config_version?: number;
    top_ledger?: unknown[];
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hudStatus = (body?.hud_status ?? "ASLEEP").trim();

  const rawPayload: Record<string, unknown> = {};
  if (typeof body?.config_version === "number") rawPayload.config_version = body.config_version;

  const { error } = await auth.admin.rpc("upsert_ea_live_state", {
    p_connection_id:    connectionId,
    p_hud_status:       hudStatus,
    p_sys_bias:         body?.sys_bias        ?? null,
    p_sys_pivot:        body?.sys_pivot       ?? null,
    p_sys_tp1:          body?.sys_tp1         ?? null,
    p_sys_tp2:          body?.sys_tp2         ?? null,
    p_invalidation_lvl: body?.invalidation_lvl ?? null,
    p_live_sl:          body?.live_sl         ?? null,
    p_live_lots:        body?.live_lots        ?? null,
    p_is_inside_zone:   body?.is_inside_zone  ?? false,
    p_is_be_secured:    body?.is_be_secured   ?? false,
    p_unrealised_pnl:   body?.unrealised_pnl  ?? null,
    p_daily_trades:     body?.daily_trades    ?? 0,
    p_daily_pnl_usd:    body?.daily_pnl_usd   ?? 0,
    p_top_ledger:       body?.top_ledger      ?? [],
    p_raw_payload:      rawPayload,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, connection_id: connectionId, hud_status: hudStatus });
}
