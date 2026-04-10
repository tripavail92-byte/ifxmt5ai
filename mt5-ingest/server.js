import crypto from "node:crypto";
import Fastify from "fastify";
import { createClient } from "redis";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10) || 3001;
const HOST = process.env.HOST ?? "0.0.0.0";
const REDIS_URL = (process.env.REDIS_URL ?? process.env.REDIS_PUBLIC_URL ?? "").trim();
const RELAY_SECRET = (process.env.RELAY_SECRET ?? process.env.SIGNING_SECRET ?? "").trim();
const HISTORY_LIMIT = Math.max(
  300,
  Number.parseInt((process.env.MT5_CANDLE_MAXBARS ?? "10000").trim(), 10) || 10000
);
const INSTANCE_ID = process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? "unknown";
const DEFAULT_SYMBOLS = (process.env.MT5_DEFAULT_SYMBOLS ?? "EURUSDm,GBPUSDm,USDJPYm,USDCADm,AUDUSDm,NZDUSDm,USDCHFm,EURGBPm,XAUUSDm,BTCUSDm,ETHUSDm,USOILm")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const STARTED_AT_MS = Date.now();

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024,
});

let redis = null;

app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
  request.rawBody = body;

  try {
    done(null, JSON.parse(body));
  } catch (error) {
    error.statusCode = 400;
    done(error, undefined);
  }
});

function pricesKey(connId) {
  return `mt5:${connId}:prices`;
}

function formingKey(connId) {
  return `mt5:${connId}:forming:1m`;
}

function symbolsKey(connId) {
  return `mt5:${connId}:symbols`;
}

function candlesKey(connId, symbol) {
  return `mt5:${connId}:candles:${symbol}:1m`;
}

function channel(connId, suffix) {
  return `mt5:${connId}:${suffix}`;
}

function sha256HexUpper(bodyText) {
  return crypto.createHash("sha256").update(bodyText, "utf8").digest("hex").toUpperCase();
}

function hmacHexUpper(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex").toUpperCase();
}

function verifySignature(canonicalPath, bodyText, headers) {
  if (!RELAY_SECRET) return true;

  const ts = String(headers["x-ifx-ts"] ?? "");
  const nonce = String(headers["x-ifx-nonce"] ?? "");
  const signature = String(headers["x-ifx-signature"] ?? "").toUpperCase();
  if (!ts || !nonce || !signature) return false;

  const bodyHash = sha256HexUpper(bodyText);
  const stringToSign = `POST\n${canonicalPath}\n${ts}\n${nonce}\n${bodyHash}`;
  const expected = hmacHexUpper(RELAY_SECRET, stringToSign);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function parseJson(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

async function ensureRedis() {
  if (redis || !REDIS_URL) return redis;
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (error) => {
    app.log.error({ error }, "Redis client error");
  });
  await redis.connect();
  return redis;
}

async function writeTickBatch(connId, ticks, formingCandles) {
  const client = await ensureRedis();
  if (!client) return false;

  const multi = client.multi();
  const seen = new Set();

  for (const tick of ticks) {
    seen.add(tick.symbol);
    multi.hSet(pricesKey(connId), tick.symbol, JSON.stringify({
      bid: tick.bid,
      ask: tick.ask,
      ts_ms: tick.ts_ms,
    }));
  }

  for (const candle of formingCandles) {
    seen.add(candle.symbol);
    multi.hSet(formingKey(connId), candle.symbol, JSON.stringify({
      t: candle.time,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.tick_vol,
    }));
  }

  if (seen.size) {
    multi.sAdd(symbolsKey(connId), [...seen]);
    multi.publish(channel(connId, "prices"), JSON.stringify({
      type: "tick_batch",
      connection_id: connId,
      ticks,
      forming_candles: formingCandles,
    }));
  }

  await multi.exec();
  return true;
}

async function writeCandleClose(connId, symbol, bar) {
  const client = await ensureRedis();
  if (!client) return false;

  const multi = client.multi();
  multi.sAdd(symbolsKey(connId), symbol);
  multi.zAdd(candlesKey(connId, symbol), { score: bar.t, value: JSON.stringify(bar) });
  multi.zRemRangeByRank(candlesKey(connId, symbol), 0, -(HISTORY_LIMIT + 1));
  multi.publish(channel(connId, "candles"), JSON.stringify({
    type: "candle_close",
    connection_id: connId,
    symbol,
    bar,
  }));
  await multi.exec();
  return true;
}

async function writeHistoricalBulk(connId, symbolsData, symbols) {
  const client = await ensureRedis();
  if (!client) return false;

  const multi = client.multi();
  const seen = new Set(symbols ?? []);

  for (const entry of symbolsData) {
    seen.add(entry.symbol);
    const key = candlesKey(connId, entry.symbol);
    if (entry.bars?.length) {
      const times = entry.bars
        .map((bar) => Number(bar?.t ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      if (!times.length) continue;

      multi.zRemRangeByScore(key, times[0], times[times.length - 1]);
      multi.zAdd(key, entry.bars.map((bar) => ({ score: bar.t, value: JSON.stringify(bar) })));
      multi.zRemRangeByRank(key, 0, -(HISTORY_LIMIT + 1));
    }
  }

  if (seen.size) {
    multi.sAdd(symbolsKey(connId), [...seen]);
    multi.publish(channel(connId, "connected"), JSON.stringify({
      type: "connected",
      connection_id: connId,
      symbols: [...seen],
    }));
  }

  await multi.exec();
  return true;
}

async function readSymbols(connId) {
  const client = await ensureRedis();
  if (!client) return [];
  return client.sMembers(symbolsKey(connId));
}

function canonicalPathFromUrl(url) {
  if (url.endsWith("/tick-batch")) return "/tick-batch";
  if (url.endsWith("/candle-close")) return "/candle-close";
  if (url.endsWith("/historical-bulk")) return "/historical-bulk";
  return url;
}

app.addHook("preHandler", async (request, reply) => {
  if (request.method !== "POST") return;
  const canonicalPath = canonicalPathFromUrl(request.url.split("?")[0] ?? request.url);
  if (!["/tick-batch", "/candle-close", "/historical-bulk"].includes(canonicalPath)) return;

  const bodyText = typeof request.rawBody === "string"
    ? request.rawBody
    : (typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
  if (!verifySignature(canonicalPath, bodyText, request.headers)) {
    reply.code(401).send({ error: "invalid signature" });
  }
});

app.get("/health", async () => ({
  status: "ok",
  instance: INSTANCE_ID,
  redis: Boolean(await ensureRedis()),
  ingest_mode: RELAY_SECRET ? "signed" : "open",
  uptime_s: Math.max(0, Math.floor((Date.now() - STARTED_AT_MS) / 1000)),
}));

app.get("/api/mt5/health", async () => ({
  status: "ok",
  instance: INSTANCE_ID,
  redis: Boolean(await ensureRedis()),
  ingest_mode: RELAY_SECRET ? "signed" : "open",
  uptime_s: Math.max(0, Math.floor((Date.now() - STARTED_AT_MS) / 1000)),
}));

app.get("/config", async (request) => {
  const connId = typeof request.query?.conn_id === "string" ? request.query.conn_id : "";
  const symbols = connId ? await readSymbols(connId) : [];
  return { symbols: symbols.length ? symbols : DEFAULT_SYMBOLS, instance: INSTANCE_ID };
});

app.get("/api/mt5/config", async (request) => {
  const connId = typeof request.query?.conn_id === "string" ? request.query.conn_id : "";
  const symbols = connId ? await readSymbols(connId) : [];
  return { symbols: symbols.length ? symbols : DEFAULT_SYMBOLS, instance: INSTANCE_ID };
});

async function handleTickBatch(request, reply) {
  const body = parseJson(typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
  if (!body?.connection_id) {
    return reply.code(400).send({ error: "invalid tick-batch payload" });
  }
  const ticks = Array.isArray(body.ticks) ? body.ticks : [];
  const formingCandles = Array.isArray(body.forming_candles) ? body.forming_candles : [];
  const wroteRedis = await writeTickBatch(body.connection_id, ticks, formingCandles);
  return reply.send({ ok: true, type: "tick_batch", connection_id: body.connection_id, redis: wroteRedis });
}

async function handleCandleClose(request, reply) {
  const body = parseJson(typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
  if (!body?.connection_id || !body.symbol || !body.time) {
    return reply.code(400).send({ error: "invalid candle-close payload" });
  }
  const bar = {
    t: Number(body.time),
    o: Number(body.open ?? 0),
    h: Number(body.high ?? 0),
    l: Number(body.low ?? 0),
    c: Number(body.close ?? 0),
    v: Number(body.tick_vol ?? 0),
  };
  const wroteRedis = await writeCandleClose(body.connection_id, body.symbol, bar);
  return reply.send({ ok: true, type: "candle_close", connection_id: body.connection_id, symbol: body.symbol, redis: wroteRedis });
}

async function handleHistoricalBulk(request, reply) {
  const body = parseJson(typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
  if (!body?.connection_id) {
    return reply.code(400).send({ error: "invalid historical-bulk payload" });
  }
  const symbolsData = Array.isArray(body.symbols_data)
    ? body.symbols_data
    : Array.isArray(body.symbols)
      ? body.symbols
          .filter((entry) => entry && typeof entry.symbol === "string")
          .map((entry) => ({
            symbol: entry.symbol,
            bars: Array.isArray(entry.bars) ? entry.bars : [],
          }))
      : [];
  const symbols = Array.isArray(body.symbols)
    ? body.symbols
        .map((entry) => (typeof entry === "string" ? entry : entry?.symbol))
        .filter((value) => typeof value === "string")
    : [];
  const wroteRedis = await writeHistoricalBulk(body.connection_id, symbolsData, symbols);
  return reply.send({ ok: true, type: "historical_bulk", connection_id: body.connection_id, symbols, redis: wroteRedis });
}

app.post("/tick-batch", handleTickBatch);
app.post("/api/mt5/tick-batch", handleTickBatch);
app.post("/candle-close", handleCandleClose);
app.post("/api/mt5/candle-close", handleCandleClose);
app.post("/historical-bulk", handleHistoricalBulk);
app.post("/api/mt5/historical-bulk", handleHistoricalBulk);

app.get("/", async () => ({
  service: "ifx-mt5-ingest",
  status: "ok",
  instance: INSTANCE_ID,
}));

const start = async () => {
  try {
    await ensureRedis();
  } catch (error) {
    app.log.warn({ error }, "Redis not connected at startup; service will retry lazily");
  }

  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (error) {
    app.log.error({ error }, "Failed to start MT5 ingest service");
    process.exit(1);
  }
};

start();