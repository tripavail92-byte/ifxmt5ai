import { NextRequest, NextResponse } from "next/server";
import { resolveTerminalAccess } from "@/lib/terminal-access";

export const runtime = "nodejs";

const PRICE_RELAY_URL = (process.env.PRICE_RELAY_URL ?? "").trim();
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = (searchParams.get("symbol") ?? "").trim();
  const requestedConnId = (searchParams.get("conn_id") ?? "").trim();

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }
  if (!PRICE_RELAY_URL) {
    return NextResponse.json({ error: "PRICE_RELAY_URL not configured" }, { status: 503 });
  }

  const access = await resolveTerminalAccess(requestedConnId || undefined);
  if (!access.authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const connId = access.connId;
  if (!connId) {
    return NextResponse.json({ error: "conn_id required" }, { status: 400 });
  }

  const url = new URL("/symbol-spec", PRICE_RELAY_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("conn_id", connId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    const data = (await resp.json()) as Record<string, unknown>;
    return NextResponse.json(data, {
      status: resp.ok ? 200 : resp.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
