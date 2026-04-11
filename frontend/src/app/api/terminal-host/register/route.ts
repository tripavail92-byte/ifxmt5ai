import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { parseJsonBody, requireManagerAuth, upsertTerminalHost } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody<{
    host_name?: string;
    host_type?: string;
    capacity?: number;
    metadata?: Record<string, unknown>;
  }>(req);

  const hostName = (body?.host_name ?? "").trim();
  if (!hostName) {
    return NextResponse.json({ error: "host_name required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const host = await upsertTerminalHost(admin, {
    hostName,
    hostType: (body?.host_type ?? "local").trim() || "local",
    capacity: Math.max(1, Number(body?.capacity ?? 1) || 1),
    metadata: body?.metadata ?? {},
    status: "online",
  });

  return NextResponse.json({ ok: true, host });
}
