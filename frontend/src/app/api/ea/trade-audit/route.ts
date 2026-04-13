import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

// GET /api/ea/trade-audit?connection_id=...&limit=50&cursor=<iso>
// Called by the dashboard (user session cookie auth) to paginate trade audit rows.
export async function GET(req: NextRequest) {
  const params       = req.nextUrl.searchParams;
  const connectionId = (params.get("connection_id") ?? "").trim();
  const limit        = Math.min(parseInt(params.get("limit") ?? "50", 10), 200);
  const cursor       = params.get("cursor"); // ISO timestamp: return rows before this

  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  // Verify authenticated user owns this connection
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("mt5_user_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  let query = admin
    .from("ea_trade_audit")
    .select("id, symbol, side, entry, sl, tp, volume, broker_ticket, status, decision_reason, payload, created_at")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = data ?? [];
  const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;
  return NextResponse.json({ rows, next_cursor: nextCursor });
}

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    symbol?: string;
    side?: string;
    entry?: number;
    sl?: number;
    tp?: number;
    volume?: number;
    decision_reason?: string;
    broker_ticket?: string;
    status?: string;
    payload?: Record<string, unknown>;
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  const { data, error } = await auth.admin
    .from("ea_trade_audit")
    .insert({
      connection_id: connectionId,
      symbol: (body?.symbol ?? "").trim(),
      side: (body?.side ?? "").trim(),
      entry: body?.entry ?? null,
      sl: body?.sl ?? null,
      tp: body?.tp ?? null,
      volume: body?.volume ?? null,
      decision_reason: body?.decision_reason ?? null,
      broker_ticket: body?.broker_ticket ?? null,
      status: (body?.status ?? "unknown").trim() || "unknown",
      payload: body?.payload ?? {},
      created_at: isoNow(),
    })
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, audit: (data ?? [])[0] ?? null });
}
