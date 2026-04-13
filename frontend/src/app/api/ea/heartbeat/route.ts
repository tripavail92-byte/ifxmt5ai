import { NextRequest, NextResponse } from "next/server";
import { ensureActiveConfig, isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    status?: string;
    metrics?: Record<string, unknown>;
    last_error?: string | null;
    terminal_path?: string | null;
    account_login?: string | null;
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
  const now = isoNow();
  let { data, error } = await auth.admin
    .from("ea_installations")
    .update({
      config_version: config.version,
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

  if (!data?.length) {
    const installationPayload = {
      connection_id: connectionId,
      host_id: auth.access?.assignment?.host_id ?? auth.access?.installation?.host_id ?? null,
      terminal_path:
        (body?.terminal_path ?? auth.access?.installation?.terminal_path ?? "").toString().trim() || null,
      ea_version: auth.access?.installation?.ea_version ?? "dev-local",
      config_version: config.version,
      status: (body?.status ?? "online").trim() || "online",
      install_token: auth.token,
      metadata_json: auth.access?.installation?.metadata_json ?? {},
      last_metrics: body?.metrics ?? {},
      last_error: body?.last_error ?? null,
      last_seen_at: now,
      created_at: auth.access?.installation?.created_at ?? now,
      updated_at: now,
    };

    const upsertResult = await auth.admin
      .from("ea_installations")
      .upsert(installationPayload, { onConflict: "connection_id" })
      .select("*")
      .limit(1);

    data = upsertResult.data ?? null;
    error = upsertResult.error;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  await auth.admin
    .from("mt5_user_connections")
    .update({ status: (body?.status ?? "online").trim() || "online" })
    .eq("id", connectionId);

  const { error: heartbeatError } = await auth.admin
    .from("mt5_worker_heartbeats")
    .upsert(
      {
        connection_id: connectionId,
        pid: Number(body?.metrics?.pid ?? 0) || 0,
        host: String(body?.metrics?.host ?? "mt5-ea"),
        status: (body?.status ?? "online").trim() || "online",
        started_at: now,
        last_seen_at: now,
        terminal_path: body?.terminal_path ?? null,
        mt5_initialized: Boolean(body?.metrics?.mt5_initialized ?? true),
        account_login: (body?.account_login ?? body?.metrics?.account_login ?? "").toString() || null,
        last_metrics: body?.metrics ?? {},
      },
      { onConflict: "connection_id" }
    );

  if (heartbeatError) {
    return NextResponse.json({ error: heartbeatError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, installation: (data ?? [])[0] ?? null });
}
