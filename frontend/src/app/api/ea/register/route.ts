import { NextRequest, NextResponse } from "next/server";
import { normalizeEaConfig } from "@/lib/ea-config";
import { ensureActiveConfig, getReleaseManifest, isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    host_id?: string;
    terminal_path?: string;
    ea_version?: string;
    metadata?: Record<string, unknown>;
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  if (!connectionId) {
    return NextResponse.json({ error: "connection_id required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  const config = await ensureActiveConfig(auth.admin, connectionId);
  const release = await getReleaseManifest(auth.admin, auth.access?.assignment?.release_channel ?? undefined);
  const normalizedConfig = normalizeEaConfig(config.config_json, connectionId, {
    releaseChannel: String(release.channel ?? "stable"),
    expectedEaVersion: String(release.version ?? "dev-local"),
    publishedAt: String(config.created_at ?? new Date().toISOString()),
  });
  const now = isoNow();
  const installationPayload = {
    connection_id: connectionId,
    host_id: (body?.host_id ?? auth.access?.assignment?.host_id ?? auth.access?.installation?.host_id ?? "").trim() || null,
    terminal_path: (body?.terminal_path ?? auth.access?.installation?.terminal_path ?? "").trim() || null,
    ea_version: (body?.ea_version ?? auth.access?.installation?.ea_version ?? "dev-local").trim() || "dev-local",
    config_version: config.version,
    status: "online",
    install_token: auth.token,
    metadata_json: body?.metadata ?? {},
    last_seen_at: now,
    created_at: auth.access?.installation?.created_at ?? now,
    updated_at: now,
  };

  const { data, error } = await auth.admin
    .from("ea_installations")
    .upsert(installationPayload, { onConflict: "connection_id" })
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await auth.admin
    .from("terminal_assignments")
    .update({ status: "active", activated_at: now, updated_at: now, last_error: null })
    .eq("connection_id", connectionId)
    .eq("install_token", auth.token);

  await auth.admin
    .from("mt5_user_connections")
    .update({ status: "online" })
    .eq("id", connectionId);

  return NextResponse.json({
    ok: true,
    installation: (data ?? [])[0] ?? null,
    config_version: config.version,
    config: normalizedConfig,
  });
}
