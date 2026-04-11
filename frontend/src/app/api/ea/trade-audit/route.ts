import { NextRequest, NextResponse } from "next/server";
import { isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

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
