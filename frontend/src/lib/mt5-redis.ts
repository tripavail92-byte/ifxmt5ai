import { createClient } from "redis";

export type PriceSnapshot = {
  bid: number;
  ask: number;
  ts_ms: number;
};

export type CandleBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

type TickPayload = {
  symbol: string;
  bid: number;
  ask: number;
  ts_ms: number;
};

type FormingPayload = {
  symbol: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_vol: number;
};

const REDIS_URL = (process.env.REDIS_URL ?? process.env.REDIS_PUBLIC_URL ?? "").trim();
const HISTORY_LIMIT = Math.max(
  300,
  Number.parseInt((process.env.MT5_CANDLE_MAXBARS ?? "10000").trim(), 10) || 10000
);

type AppRedisClient = ReturnType<typeof createClient>;

let clientPromise: Promise<AppRedisClient | null> | null = null;

function pricesKey(connId: string) {
  return `mt5:${connId}:prices`;
}

function formingKey(connId: string) {
  return `mt5:${connId}:forming:1m`;
}

function symbolsKey(connId: string) {
  return `mt5:${connId}:symbols`;
}

function candlesKey(connId: string, symbol: string) {
  return `mt5:${connId}:candles:${symbol}:1m`;
}

function pricesChannel(connId: string) {
  return `mt5:${connId}:prices`;
}

function candlesChannel(connId: string) {
  return `mt5:${connId}:candles`;
}

function connectedChannel(connId: string) {
  return `mt5:${connId}:connected`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function getRedis(): Promise<AppRedisClient | null> {
  if (!REDIS_URL) return null;

  if (!clientPromise) {
    clientPromise = (async () => {
      const client = createClient({ url: REDIS_URL });
      client.on("error", () => {
        // Keep route handlers alive; callers fall back to in-memory state.
      });
      await client.connect();
      return client;
    })().catch(() => null);
  }

  return clientPromise;
}

export async function redisAvailable(): Promise<boolean> {
  return (await getRedis()) !== null;
}

export async function createRedisSubscriber(): Promise<AppRedisClient | null> {
  const redis = await getRedis();
  if (!redis) return null;

  const subscriber = redis.duplicate();
  subscriber.on("error", () => {
    // Stream routes fall back gracefully if the subscriber disconnects.
  });
  await subscriber.connect();
  return subscriber;
}

export async function writeTickBatchToRedis(
  connId: string,
  ticks: TickPayload[],
  formingCandles: FormingPayload[]
) {
  const redis = await getRedis();
  if (!redis) return false;

  const multi = redis.multi();
  const nowIso = new Date().toISOString();

  const seenSymbols = new Set<string>();
  for (const tick of ticks) {
    seenSymbols.add(tick.symbol);
    multi.hSet(pricesKey(connId), tick.symbol, JSON.stringify({
      bid: tick.bid,
      ask: tick.ask,
      ts_ms: tick.ts_ms,
    } satisfies PriceSnapshot));
  }

  for (const candle of formingCandles) {
    seenSymbols.add(candle.symbol);
    multi.hSet(formingKey(connId), candle.symbol, JSON.stringify({
      t: candle.time,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.tick_vol,
    } satisfies CandleBar));
  }

  if (seenSymbols.size) {
    multi.sAdd(symbolsKey(connId), [...seenSymbols]);
    multi.publish(pricesChannel(connId), JSON.stringify({
      type: "tick_batch",
      connection_id: connId,
      observed_at: nowIso,
      ticks,
      forming_candles: formingCandles,
    }));
  }

  await multi.exec();
  return true;
}

export async function writeCandleCloseToRedis(connId: string, symbol: string, bar: CandleBar) {
  const redis = await getRedis();
  if (!redis) return false;

  const key = candlesKey(connId, symbol);
  const member = JSON.stringify(bar);
  const multi = redis.multi();
  multi.sAdd(symbolsKey(connId), symbol);
  multi.zAdd(key, { score: bar.t, value: member });
  multi.zRemRangeByRank(key, 0, -(HISTORY_LIMIT + 1));
  multi.publish(candlesChannel(connId), JSON.stringify({
    type: "candle_close",
    connection_id: connId,
    symbol,
    bar,
  }));
  await multi.exec();
  return true;
}

export async function writeHistoricalBulkToRedis(
  connId: string,
  symbolsData: Array<{ symbol: string; bars: CandleBar[] }>,
  symbolNames?: string[]
) {
  const redis = await getRedis();
  if (!redis) return false;

  const multi = redis.multi();
  const seenSymbols = new Set<string>(symbolNames ?? []);

  for (const entry of symbolsData) {
    seenSymbols.add(entry.symbol);
    const key = candlesKey(connId, entry.symbol);
    if (entry.bars.length) {
      const times = entry.bars
        .map((bar) => Number(bar?.t ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      if (!times.length) continue;

      multi.zRemRangeByScore(key, times[0], times[times.length - 1]);
      multi.zAdd(
        key,
        entry.bars.map((bar) => ({ score: bar.t, value: JSON.stringify(bar) }))
      );
      multi.zRemRangeByRank(key, 0, -(HISTORY_LIMIT + 1));
    }
  }

  if (seenSymbols.size) {
    multi.sAdd(symbolsKey(connId), [...seenSymbols]);
    multi.publish(connectedChannel(connId), JSON.stringify({
      type: "connected",
      connection_id: connId,
      symbols: [...seenSymbols],
    }));
  }

  await multi.exec();
  return true;
}

export async function getRedisPrices(connId: string): Promise<Record<string, PriceSnapshot>> {
  const redis = await getRedis();
  if (!redis) return {};

  const raw = await redis.hGetAll(pricesKey(connId));
  const out: Record<string, PriceSnapshot> = {};
  for (const [symbol, value] of Object.entries(raw)) {
    const parsed = parseJson<PriceSnapshot>(value);
    if (parsed) out[symbol] = parsed;
  }
  return out;
}

export async function getRedisForming(connId: string): Promise<Record<string, CandleBar>> {
  const redis = await getRedis();
  if (!redis) return {};

  const raw = await redis.hGetAll(formingKey(connId));
  const out: Record<string, CandleBar> = {};
  for (const [symbol, value] of Object.entries(raw)) {
    const parsed = parseJson<CandleBar>(value);
    if (parsed) out[symbol] = parsed;
  }
  return out;
}

export async function getRedisSymbols(connId: string): Promise<string[]> {
  const redis = await getRedis();
  if (!redis) return [];
  return redis.sMembers(symbolsKey(connId));
}

export async function getRedisCandles(connId: string, symbol: string, count: number): Promise<CandleBar[]> {
  const redis = await getRedis();
  if (!redis) return [];

  const start = Math.max(0, -count);
  const raw = await redis.zRange(candlesKey(connId, symbol), start, -1);
  return raw
    .map((entry) => parseJson<CandleBar>(entry))
    .filter((entry): entry is CandleBar => entry !== null)
    .sort((a, b) => a.t - b.t);
}