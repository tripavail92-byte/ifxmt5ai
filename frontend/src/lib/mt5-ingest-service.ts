import { NextRequest, NextResponse } from "next/server";
import { mt5State, type CandleBar } from "@/lib/mt5-state";
import {
  writeCandleCloseToRedis,
  writeHistoricalBulkToRedis,
  writeTickBatchToRedis,
  redisAvailable,
} from "@/lib/mt5-redis";
import { getRelayAuthMode, hasSigningSecret, verifySignedBody } from "@/lib/mt5-ingest-auth";

const INGEST_TOKEN = process.env.RELAY_INGEST_TOKEN ?? "";
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";

type IngestMode = "signed" | "bearer";

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 });
}

async function authorize(req: NextRequest, canonicalPath: string, bodyText: string, mode: IngestMode) {
  if (mode === "signed") {
    const connectionId = (req.headers.get("X-IFX-CONN-ID") ?? "").trim();
    if (!connectionId) {
      return unauthorized("missing connection id");
    }

    const ts = req.headers.get("X-IFX-TS") ?? "";
    const nonce = req.headers.get("X-IFX-NONCE") ?? "";
    const signature = req.headers.get("X-IFX-SIGNATURE") ?? "";
    if (!(await verifySignedBody({ connectionId, canonicalPath, bodyText, ts, nonce, signature }))) {
      return unauthorized("invalid signature");
    }
    return null;
  }

  if (INGEST_TOKEN) {
    const auth = req.headers.get("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (provided !== INGEST_TOKEN) {
      return unauthorized("unauthorized");
    }
  }
  return null;
}

function parseJson<T>(bodyText: string): T | null {
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return null;
  }
}

export async function handleTickBatch(req: NextRequest, canonicalPath: string, mode: IngestMode) {
  const bodyText = await req.text();
  const authError = await authorize(req, canonicalPath, bodyText, mode);
  if (authError) return authError;

  const body = parseJson<{
    connection_id?: string;
    ticks?: Array<{ symbol: string; bid: number; ask: number; ts_ms: number }>;
    forming_candles?: Array<{ symbol: string; time: number; open: number; high: number; low: number; close: number; tick_vol: number }>;
  }>(bodyText);
  if (!body) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const connId = body.connection_id ?? "default";
  const ticks = body.ticks ?? [];
  const forming = body.forming_candles ?? [];

  mt5State.applyTickBatch(connId, ticks, forming);
  const wroteRedis = await writeTickBatchToRedis(connId, ticks, forming);

  return NextResponse.json({
    ok: true,
    type: "tick_batch",
    connection_id: connId,
    subscribers: mt5State.subscriberCount,
    redis: wroteRedis,
  });
}

export async function handleCandleClose(req: NextRequest, canonicalPath: string, mode: IngestMode) {
  const bodyText = await req.text();
  const authError = await authorize(req, canonicalPath, bodyText, mode);
  if (authError) return authError;

  const body = parseJson<{
    connection_id?: string;
    symbol?: string;
    time?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    tick_vol?: number;
  }>(bodyText);
  if (!body?.connection_id || !body.symbol || !body.time) {
    return NextResponse.json({ error: "invalid candle-close payload" }, { status: 400 });
  }

  const bar: CandleBar = {
    t: body.time,
    o: Number(body.open ?? 0),
    h: Number(body.high ?? 0),
    l: Number(body.low ?? 0),
    c: Number(body.close ?? 0),
    v: Number(body.tick_vol ?? 0),
  };

  mt5State.applyCandleClose(body.connection_id, body.symbol, bar);
  const wroteRedis = await writeCandleCloseToRedis(body.connection_id, body.symbol, bar);

  return NextResponse.json({
    ok: true,
    type: "candle_close",
    connection_id: body.connection_id,
    symbol: body.symbol,
    redis: wroteRedis,
  });
}

export async function handleHistoricalBulk(req: NextRequest, canonicalPath: string, mode: IngestMode) {
  const bodyText = await req.text();
  const authError = await authorize(req, canonicalPath, bodyText, mode);
  if (authError) return authError;

  const body = parseJson<{
    connection_id?: string;
    symbols?: Array<string | { symbol: string; bars: CandleBar[] }>;
    symbols_data?: Array<{ symbol: string; bars: CandleBar[] }>;
  }>(bodyText);
  if (!body?.connection_id) {
    return NextResponse.json({ error: "invalid historical-bulk payload" }, { status: 400 });
  }

  const symbolsPayload = body.symbols ?? [];
  const symbolsData = body.symbols_data?.length
    ? body.symbols_data
    : symbolsPayload.filter((entry): entry is { symbol: string; bars: CandleBar[] } => typeof entry !== "string");
  const symbolNames = symbolsPayload
    .filter((entry): entry is string => typeof entry === "string")
    .concat(symbolsData.map((entry) => entry.symbol));

  if (symbolsData.length) {
    mt5State.applyHistoricalBulk(body.connection_id, symbolsData);
  } else if (symbolNames.length) {
    mt5State.symbols.set(body.connection_id, [...new Set(symbolNames)]);
    mt5State.broadcast({ type: "connected", connection_id: body.connection_id, symbols: [...new Set(symbolNames)] });
  }

  const wroteRedis = await writeHistoricalBulkToRedis(body.connection_id, symbolsData, symbolNames);

  return NextResponse.json({
    ok: true,
    type: "historical_bulk",
    connection_id: body.connection_id,
    symbols: [...new Set(symbolNames)],
    redis: wroteRedis,
  });
}

export async function handleRelayHealth() {
  return NextResponse.json({
    status: "ok",
    ingest_mode: getRelayAuthMode(),
    global_signing_secret: hasSigningSecret(),
    scoped_install_tokens: true,
    redis: await redisAvailable(),
    subscribers: mt5State.subscriberCount,
    symbols: mt5State.getSymbols(),
    instance: INSTANCE_ID,
  });
}

export async function handleRelayConfig() {
  const symbols = [...new Set(mt5State.getSymbols())];
  return NextResponse.json({
    symbols: symbols.length
      ? symbols
      : [
          "EURUSDm","GBPUSDm","USDJPYm","USDCADm","AUDUSDm",
          "NZDUSDm","USDCHFm","EURGBPm","XAUUSDm","BTCUSDm",
          "ETHUSDm","USOILm",
        ],
    redis: await redisAvailable(),
    instance: INSTANCE_ID,
  });
}