import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { ensureActiveConfig, ensureBootstrapAssignment, getReleaseManifest, loadConnection, parseJsonBody, requireManagerAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const body = await parseJsonBody<{
    connection_id?: string;
    host_id?: string;
    release_channel?: string;
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  const hostId = (body?.host_id ?? "").trim();
  if (!connectionId || !hostId) {
    return NextResponse.json({ error: "connection_id and host_id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const connection = await loadConnection(admin, connectionId);
  if (!connection) {
    return NextResponse.json({ error: "connection not found" }, { status: 404 });
  }

  const config = await ensureActiveConfig(admin, connectionId);
  const assignment = await ensureBootstrapAssignment(admin, {
    connectionId,
    hostId,
    releaseChannel: body?.release_channel,
  });
  const release = await getReleaseManifest(admin, assignment.release_channel ?? undefined);

  return NextResponse.json({
    ok: true,
    connection,
    config,
    assignment,
    release,
  });
}
