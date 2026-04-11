import { NextRequest, NextResponse } from "next/server";
import { isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    status?: string;
    metrics?: Record<string, unknown>;
    last_error?: string | null;
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  const now = isoNow();
  const { data, error } = await auth.admin
    .from("ea_installations")
    .update({
      status: (body?.status ?? "online").trim() || "online",
      last_metrics: body?.metrics ?? {},
      last_error: body?.last_error ?? null,
      last_seen_at: now,
      updated_at: now,
    })
    .eq("connection_id", connectionId)
    .eq("install_token", auth.token)
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await auth.admin
    .from("mt5_user_connections")
    .update({ status: (body?.status ?? "online").trim() || "online" })
    .eq("id", connectionId);

  return NextResponse.json({ ok: true, installation: (data ?? [])[0] ?? null });
}
