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
    error?: string;
    details?: Record<string, unknown>;
  }>(req);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("terminal_assignments")
    .update({
      status: (body?.status ?? "failed").trim() || "failed",
      last_error: (body?.error ?? "terminal manager reported failure").trim(),
      activation_details: body?.details ?? {},
      updated_at: isoNow(),
    })
    .eq("id", assignmentId)
    .select("*")
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, assignment: (data ?? [])[0] ?? null });
}
