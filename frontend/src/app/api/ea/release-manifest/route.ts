import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { getReleaseManifest, requireManagerAuth } from "@/lib/ea-control-plane";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const channel = (req.nextUrl.searchParams.get("channel") ?? "").trim() || undefined;
  const admin = createAdminClient();
  const release = await getReleaseManifest(admin, channel);
  return NextResponse.json({ ok: true, release });
}
