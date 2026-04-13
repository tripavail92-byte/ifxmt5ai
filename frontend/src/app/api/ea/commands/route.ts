import { NextRequest, NextResponse } from "next/server";
import { isoNow, requireEaAuth } from "@/lib/ea-control-plane";

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

  const cursor = Number(req.nextUrl.searchParams.get("cursor") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const now = isoNow();

  const { error: expireError } = await auth.admin
    .from("ea_commands")
    .update({ status: "expired", updated_at: now })
    .eq("connection_id", connectionId)
    .eq("status", "pending")
    .lt("expires_at", now);

  if (expireError) {
    return NextResponse.json({ error: expireError.message }, { status: 500 });
  }

  const { data, error } = await auth.admin
    .from("ea_commands")
    .select("id, connection_id, command_type, payload_json, sequence_no, idempotency_key, status, created_at, expires_at")
    .eq("connection_id", connectionId)
    .eq("status", "pending")
    .gt("sequence_no", cursor)
    .order("sequence_no", { ascending: true })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const commands = (data ?? [])
    .filter((command) => !command.expires_at || String(command.expires_at) > now)
    .map((command) => ({
      id: command.id,
      sequence_no: command.sequence_no,
      command_type: command.command_type,
      payload: command.payload_json ?? {},
      idempotency_key: command.idempotency_key,
      created_at: command.created_at,
      expires_at: command.expires_at,
      status: command.status,
    }));
  const nextCursor = commands.length > 0 ? Number(commands[commands.length - 1]?.sequence_no ?? cursor) : cursor;

  return NextResponse.json({ ok: true, connection_id: connectionId, cursor, next_cursor: nextCursor, commands });
}