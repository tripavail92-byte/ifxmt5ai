import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isoNow, parseJsonBody, requireManagerAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

type Params = { params: Promise<{ assignmentId: string }> };

export async function POST(req: NextRequest, context: Params) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const { assignmentId } = await context.params;
  const body = await parseJsonBody<{
    status?: string;
    terminal_path?: string;
    details?: Record<string, unknown>;
  }>(req);

  const admin = createAdminClient();
  const now = isoNow();
  const status = (body?.status ?? "launched").trim() || "launched";
  const payload: Record<string, unknown> = {
    status,
    terminal_path: body?.terminal_path ?? null,
    activation_details: body?.details ?? {},
    last_error: null,
    updated_at: now,
  };
  if (status === "active" || status === "launched") {
    payload.activated_at = now;
  }

  const { data, error } = await admin
    .from("terminal_assignments")
    .update(payload)
    .eq("id", assignmentId)
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, assignment: (data ?? [])[0] ?? null });
}
