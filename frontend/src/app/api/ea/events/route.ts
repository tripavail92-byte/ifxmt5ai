import { NextRequest, NextResponse } from "next/server";
import { isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    events?: Array<{ event_type: string; payload?: Record<string, unknown> }>;
    event_type?: string;
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

  const events = body?.events?.length
    ? body.events
    : body?.event_type
      ? [{ event_type: body.event_type, payload: body.payload ?? {} }]
      : [];

  if (!events.length) {
    return NextResponse.json({ error: "event payload required" }, { status: 400 });
  }

  const now = isoNow();
  const rows = events.map((event) => ({
    connection_id: connectionId,
    event_type: event.event_type,
    payload: event.payload ?? {},
    created_at: now,
  }));

  const { error } = await auth.admin.from("ea_runtime_events").insert(rows);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
