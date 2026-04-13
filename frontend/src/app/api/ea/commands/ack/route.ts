import { NextRequest, NextResponse } from "next/server";
import { isoNow, parseJsonBody, requireEaAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await parseJsonBody<{
    connection_id?: string;
    command_id?: string;
    sequence_no?: number;
    status?: string;
    ack_payload_json?: Record<string, unknown>;
    applied_config_version?: number;
  }>(req);

  const connectionId = (body?.connection_id ?? "").trim();
  const commandId = (body?.command_id ?? "").trim();
  const sequenceNo = Number(body?.sequence_no ?? 0) || 0;
  if (!connectionId || !commandId || sequenceNo <= 0) {
    return NextResponse.json({ error: "connection_id, command_id, and sequence_no required" }, { status: 400 });
  }

  const auth = await requireEaAuth(req, connectionId);
  if (auth.error || !auth.admin) {
    return auth.error;
  }

  const now = isoNow();
  const ackStatus = (body?.status ?? "acknowledged").trim() || "acknowledged";

  const { error: ackError } = await auth.admin
    .from("ea_command_acks")
    .upsert(
      {
        command_id: commandId,
        connection_id: connectionId,
        sequence_no: sequenceNo,
        status: ackStatus,
        ack_payload_json: body?.ack_payload_json ?? {},
        acknowledged_at: now,
        created_at: now,
      },
      { onConflict: "command_id" },
    );

  if (ackError) {
    return NextResponse.json({ error: ackError.message }, { status: 500 });
  }

  const { error: commandError } = await auth.admin
    .from("ea_commands")
    .update({ status: ackStatus, updated_at: now })
    .eq("id", commandId)
    .eq("connection_id", connectionId);

  if (commandError) {
    return NextResponse.json({ error: commandError.message }, { status: 500 });
  }

  const installUpdate: Record<string, unknown> = {
    last_command_sequence: sequenceNo,
    updated_at: now,
  };
  if (typeof body?.applied_config_version === "number" && Number.isFinite(body.applied_config_version)) {
    installUpdate.applied_config_version = body.applied_config_version;
  }

  let { error: installationError } = await auth.admin
    .from("ea_installations")
    .update(installUpdate)
    .eq("connection_id", connectionId)
    .eq("install_token", auth.token);

  if (installationError && /column .* does not exist/i.test(installationError.message)) {
    const fallbackUpdate = { updated_at: now };
    const fallbackResult = await auth.admin
      .from("ea_installations")
      .update(fallbackUpdate)
      .eq("connection_id", connectionId)
      .eq("install_token", auth.token);
    installationError = fallbackResult.error;
  }

  if (installationError) {
    return NextResponse.json({ error: installationError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, connection_id: connectionId, command_id: commandId, sequence_no: sequenceNo, status: ackStatus });
}