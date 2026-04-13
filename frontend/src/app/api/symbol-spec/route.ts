import { NextRequest, NextResponse } from "next/server";
import { SERVER_PRICE_RELAY_URL, relayConnectionId } from "@/lib/price-relay";
import { resolveTerminalAccess } from "@/lib/terminal-access";
import { getRedisPrices, getRedisSymbols } from "@/lib/mt5-redis";
import { mt5State } from "@/lib/mt5-state";

export const runtime = "nodejs";

const PRICE_RELAY_URL = SERVER_PRICE_RELAY_URL;
const PRICE_RELAY_TIMEOUT_MS = Math.max(
  500,
  Number.parseInt((process.env.PRICE_RELAY_TIMEOUT_MS ?? "5000").trim(), 10) || 5000
);

function inferDigits(symbol: string): number {
  if (/JPY/i.test(symbol)) return 3;
  if (/XAU|XAG/i.test(symbol)) return 3;
  if (/BTC|ETH|OIL/i.test(symbol)) return 2;
  return 5;
}

function fallbackSpec(symbol: string, livePrice?: { bid?: number | null; ask?: number | null }) {
  const digits = inferDigits(symbol);
  const point = 1 / 10 ** digits;
  return {
    symbol,
    digits,
    point,
    trade_tick_size: point,
    trade_tick_value: 0,
    volume_min: 0.01,
    volume_max: 100,
    volume_step: 0.01,
    bid: livePrice?.bid ?? null,
    ask: livePrice?.ask ?? null,
    resolved_symbol: symbol,
    source: "fallback",
  };
}

async function resolveLivePrice(connId: string, symbol: string) {
  const redisPrices = await getRedisPrices(connId);
  const redisQuote = redisPrices[symbol];
  if (redisQuote) {
    return { bid: redisQuote.bid, ask: redisQuote.ask };
  }

  const memoryPrices = mt5State.getPrices(connId);
  const memoryQuote = memoryPrices[symbol];
  if (memoryQuote) {
    return { bid: memoryQuote.bid, ask: memoryQuote.ask };
  }

  return { bid: null, ask: null };
}

function normalizeAliasCandidate(symbol: string) {
  return symbol
    .trim()
    .replace(/[._-]?(micro|mini)$/i, "")
    .replace(/m$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
}

async function resolveConnectionSymbol(connId: string, requestedSymbol: string) {
  const requested = requestedSymbol.trim();
  if (!requested) return requested;

  const stateSymbols = mt5State.getSymbols(connId) ?? [];
  const redisSymbols = await getRedisSymbols(connId);
  const candidates = [...new Set([...stateSymbols, ...redisSymbols].filter(Boolean))];
  if (!candidates.length) return requested;

  const exactMatch = candidates.find((symbol) => symbol === requested);
  if (exactMatch) return exactMatch;

  const normalizedRequested = normalizeAliasCandidate(requested);
  if (!normalizedRequested) return requested;

  return candidates.find((symbol) => {
    const normalizedCandidate = normalizeAliasCandidate(symbol);
    if (normalizedCandidate === normalizedRequested) return true;
    if (normalizedCandidate.startsWith(normalizedRequested) && (normalizedCandidate.length - normalizedRequested.length) <= 4) return true;
    return normalizedRequested.startsWith(normalizedCandidate) && (normalizedRequested.length - normalizedCandidate.length) <= 4;
  }) ?? requested;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const symbol = (searchParams.get("symbol") ?? "").trim();
  const requestedConnId = (searchParams.get("conn_id") ?? "").trim();

  if (!symbol) {
    return NextResponse.json({ error: "symbol required" }, { status: 400 });
  }

  const access = await resolveTerminalAccess(requestedConnId || undefined);
  if (!access.authorized) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const stateConnId = access.connId;
  const relayConnId = relayConnectionId(stateConnId);
  const effectiveConnId = relayConnId || stateConnId || "";
  if (!stateConnId) {
    return NextResponse.json({ error: "conn_id required" }, { status: 400 });
  }

  const effectiveSymbol = await resolveConnectionSymbol(stateConnId, symbol);
  const livePrice = await resolveLivePrice(stateConnId, effectiveSymbol);

  if (!PRICE_RELAY_URL) {
    return NextResponse.json(fallbackSpec(effectiveSymbol, livePrice), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const url = new URL("/symbol-spec", PRICE_RELAY_URL);
  url.searchParams.set("symbol", effectiveSymbol);
  if (effectiveConnId) url.searchParams.set("conn_id", effectiveConnId);

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
    if (!resp.ok || data.error) {
      return NextResponse.json(fallbackSpec(effectiveSymbol, livePrice), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json({ ...data, resolved_symbol: effectiveSymbol }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(fallbackSpec(effectiveSymbol, livePrice), {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    clearTimeout(timeout);
  }
}
