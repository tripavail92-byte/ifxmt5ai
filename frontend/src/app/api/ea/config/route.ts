import { NextRequest, NextResponse } from "next/server";
import { ensureActiveConfig, getReleaseManifest, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const connectionId = (req.nextUrl.searchParams.get("connection_id") ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  const requestedVersion = Number(req.nextUrl.searchParams.get("version") ?? 0) || 0;
  const config = await ensureActiveConfig(auth.admin, connectionId);
  const release = await getReleaseManifest(auth.admin, auth.access?.assignment?.release_channel ?? undefined);

  return NextResponse.json({
    ok: true,
    connection_id: connectionId,
    version: config.version,
    changed: requestedVersion !== config.version,
    config: config.config_json,
    release,
  });
}
