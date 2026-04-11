import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { ensureActiveConfig, getReleaseManifest, loadConnection, requireManagerAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const hostId = (req.nextUrl.searchParams.get("host_id") ?? "").trim();
  if (!hostId) {
    return NextResponse.json({ error: "host_id required" }, { status: 400 });
  }

  const limit = Math.max(1, Math.min(20, Number(req.nextUrl.searchParams.get("limit") ?? 10) || 10));
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("terminal_assignments")
    .select("id, connection_id, host_id, status, install_token, assigned_at, activated_at, release_channel, last_error")
    .eq("host_id", hostId)
    .in("status", ["pending", "retry"])
    .order("assigned_at", { ascending: true })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const assignments = await Promise.all(
    (data ?? []).map(async (assignment) => {
      const connection = await loadConnection(admin, assignment.connection_id);
      const config = await ensureActiveConfig(admin, assignment.connection_id);
      const release = await getReleaseManifest(admin, assignment.release_channel ?? undefined);
      return {
        ...assignment,
        connection,
        config_version: config.version,
        release,
      };
    }),
  );

  return NextResponse.json({ ok: true, assignments });
}
