import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    // Auth check — only logged-in users
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ events: [], error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const hours = Math.min(Math.max(parseInt(searchParams.get("hours") ?? "48", 10), 1), 168);
    const impacts = (searchParams.get("impacts") ?? "high,medium").split(",").filter(Boolean);

    const now = new Date();
    const end = new Date(now.getTime() + hours * 3_600_000);

    const { data, error } = await supabase
      .from("economic_events")
      .select("id, currency, country, title, impact, scheduled_at_utc, category, provider")
      .gte("scheduled_at_utc", now.toISOString())
      .lte("scheduled_at_utc", end.toISOString())
      .in("impact", impacts)
      .order("scheduled_at_utc", { ascending: true })
      .limit(100);

    if (error) {
      // Table not yet created — return empty gracefully
      const msg = error.message.toLowerCase();
      if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("schema cache")) {
        return NextResponse.json({ events: [], status: "no_table" });
      }
      return NextResponse.json({ events: [], error: error.message }, { status: 500 });
    }

    return NextResponse.json({ events: data ?? [], status: "ok" });
  } catch (err) {
    return NextResponse.json({ events: [], error: String(err) }, { status: 500 });
  }
}
