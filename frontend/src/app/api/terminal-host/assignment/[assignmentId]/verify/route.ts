import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireManagerAuth } from "@/lib/ea-control-plane";
import { getRedisCandles, getRedisPrices, getRedisSymbols } from "@/lib/mt5-redis";

export const runtime = "nodejs";

function isFresh(value?: string | null, maxAgeMs = 120_000) {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= maxAgeMs;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
) {
  const authError = requireManagerAuth(req);
  if (authError) return authError;

  const { assignmentId } = await context.params;
  const admin = createAdminClient();

  const { data: assignmentRows, error: assignmentError } = await admin
    .from("terminal_assignments")
    .select("id, connection_id, status, terminal_path, assigned_at, activated_at")
    .eq("id", assignmentId)
    .limit(1);

  if (assignmentError) {
    return NextResponse.json({ error: assignmentError.message }, { status: 500 });
  }

  const assignment = (assignmentRows ?? [])[0];
  if (!assignment?.connection_id) {
    return NextResponse.json({ error: "assignment not found" }, { status: 404 });
  }

  const connectionId = String(assignment.connection_id);

  const [{ data: heartbeatRows, error: heartbeatError }, { data: installationRows, error: installationError }, { data: symbolRows, error: symbolError }] = await Promise.all([
    admin
      .from("mt5_worker_heartbeats")
      .select("connection_id, status, last_seen_at, mt5_initialized, last_metrics")
      .eq("connection_id", connectionId)
      .limit(1),
    admin
      .from("ea_installations")
      .select("connection_id, status, last_seen_at, last_metrics, last_error")
      .eq("connection_id", connectionId)
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("mt5_symbols")
      .select("symbol")
      .eq("connection_id", connectionId)
      .order("symbol")
      .limit(20),
  ]);

  if (heartbeatError || installationError || symbolError) {
    return NextResponse.json(
      { error: heartbeatError?.message ?? installationError?.message ?? symbolError?.message ?? "verification failed" },
      { status: 500 },
    );
  }

  const heartbeat = (heartbeatRows ?? [])[0] ?? null;
  const installation = (installationRows ?? [])[0] ?? null;
  const redisPrices = await getRedisPrices(connectionId);
  const redisSymbols = await getRedisSymbols(connectionId);

  const candidateSymbols = [
    ...redisSymbols,
    ...((symbolRows ?? []) as Array<{ symbol?: string | null }>).map((row) => String(row.symbol ?? "")).filter(Boolean),
  ];
  const uniqueSymbols = [...new Set(candidateSymbols)];
  let historicalSymbol = "";
  let historicalCount = 0;

  for (const symbol of uniqueSymbols.slice(0, 12)) {
    const bars = await getRedisCandles(connectionId, symbol, 50);
    if (bars.length > historicalCount) {
      historicalCount = bars.length;
      historicalSymbol = symbol;
    }
    if (historicalCount > 0) break;
  }

  const heartbeatFresh = Boolean(
    (heartbeat?.mt5_initialized && isFresh(heartbeat?.last_seen_at))
    || (installation?.status === "online" && isFresh(installation?.last_seen_at))
  );
  const tickReceived = Object.keys(redisPrices).length > 0;
  const historyReady = historicalCount > 0;

  return NextResponse.json({
    ok: heartbeatFresh && tickReceived && historyReady,
    assignment,
    connection_id: connectionId,
    verification: {
      heartbeat_fresh: heartbeatFresh,
      tick_received: tickReceived,
      history_ready: historyReady,
      redis_price_count: Object.keys(redisPrices).length,
      redis_symbol_count: redisSymbols.length,
      historical_symbol: historicalSymbol || null,
      historical_count: historicalCount,
      heartbeat,
      installation,
    },
  });
}