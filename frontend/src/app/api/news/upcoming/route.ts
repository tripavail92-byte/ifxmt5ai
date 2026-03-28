import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ events: [], error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);

    // Support either hours-ahead OR explicit from/to dates
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const hours = Math.min(Math.max(parseInt(searchParams.get("hours") ?? "48", 10), 1), 336);

    const now = new Date();
    const from = fromParam ? new Date(fromParam) : now;
    const to = toParam ? new Date(toParam) : new Date(now.getTime() + hours * 3_600_000);

    // Impact filter — default high+medium; "all" returns everything
    const impactParam = searchParams.get("impacts") ?? "high,medium";
    const impacts = impactParam === "all"
      ? ["high", "medium", "low", "unknown"]
      : impactParam.split(",").filter(Boolean);

    // Currency filter (optional)
    const currencyParam = searchParams.get("currencies");
    const currencies = currencyParam ? currencyParam.split(",").filter(Boolean) : null;

    let query = supabase
      .from("economic_events")
      .select("id, currency, country, title, impact, scheduled_at_utc, category, provider")
      .gte("scheduled_at_utc", from.toISOString())
      .lte("scheduled_at_utc", to.toISOString())
      .in("impact", impacts)
      .order("scheduled_at_utc", { ascending: true })
      .limit(500);

    if (currencies && currencies.length > 0) {
      query = query.in("currency", currencies);
    }

    const { data, error } = await query;

    if (error) {
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
