import { NextRequest, NextResponse } from "next/server";
import { normalizeEaConfig } from "@/lib/ea-config";
import { ensureActiveConfig, getReleaseManifest, patchEaConfigVisuals, requireEaAuth } from "@/lib/ea-control-plane";

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
  const normalizedConfig = normalizeEaConfig(config.config_json, connectionId, {
    releaseChannel: String(release.channel ?? "stable"),
    expectedEaVersion: String(release.version ?? "dev-local"),
    publishedAt: String(config.created_at ?? new Date().toISOString()),
  });

  return NextResponse.json({
    ok: true,
    connection_id: connectionId,
    version: config.version,
    changed: requestedVersion !== config.version,
    schema_version: normalizedConfig.meta.schema_version,
    published_at: normalizedConfig.meta.published_at,
    config: normalizedConfig,
    release,
  });
}

export async function PATCH(req: NextRequest) {
  const connectionId = (req.nextUrl.searchParams.get("connection_id") ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const visuals = body.visuals as Record<string, unknown> | undefined;
  if (!visuals || typeof visuals !== "object") {
    return NextResponse.json({ error: "Body must contain a 'visuals' object" }, { status: 400 });
  }

  const patch: { show_struct?: boolean; smc_lookback?: number } = {};
  if (typeof visuals.show_struct === "boolean") patch.show_struct = visuals.show_struct;
  if (typeof visuals.smc_lookback === "number" && visuals.smc_lookback > 0) {
    patch.smc_lookback = Math.min(Math.round(visuals.smc_lookback), 5000);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid visuals fields to patch" }, { status: 400 });
  }

  const result = await patchEaConfigVisuals(auth.admin, connectionId, patch);
  return NextResponse.json({ ok: true, changed: result.changed });
}
