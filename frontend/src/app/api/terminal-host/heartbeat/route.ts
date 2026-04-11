import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isoNow, parseJsonBody, requireManagerAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody<{
    host_id?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  }>(req);

  const hostId = (body?.host_id ?? "").trim();
  if (!hostId) {
    return NextResponse.json({ error: "host_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const now = isoNow();
  const { data, error } = await admin
    .from("terminal_hosts")
    .update({
      status: (body?.status ?? "online").trim() || "online",
      metadata: body?.metadata ?? {},
      last_seen_at: now,
      updated_at: now,
    })
    .eq("id", hostId)
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, host: (data ?? [])[0] ?? null });
}
