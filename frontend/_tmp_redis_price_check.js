const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const envRaw = fs.readFileSync(path.join('..', '.env'), 'utf8');
const env = {};
for (const raw of envRaw.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const idx = line.indexOf('=');
  env[line.slice(0, idx)] = line.slice(idx + 1);
}
const redisUrl = (env.REDIS_URL || env.REDIS_PUBLIC_URL || '').trim();
if (!redisUrl) throw new Error('REDIS_URL missing');
const client = createClient({ url: redisUrl });

(async () => {
  await client.connect();
  const connId = 'c9fc4e21-f284-4c86-999f-ddedd5649734';
  const symbol = 'BTCUSDm';
  const priceRaw = await client.hGet(`mt5:${connId}:prices`, symbol);
  const formingRaw = await client.hGet(`mt5:${connId}:forming:1m`, symbol);
  const symbols = await client.sMembers(`mt5:${connId}:symbols`);
  await client.quit();
  const now = Date.now();
  const price = priceRaw ? JSON.parse(priceRaw) : null;
  const forming = formingRaw ? JSON.parse(formingRaw) : null;
  console.log(JSON.stringify({
    now,
    price,
    priceAgeMs: price?.ts_ms ? now - price.ts_ms : null,
    forming,
    formingAgeMs: forming?.t ? now - (forming.t * 1000) : null,
    hasSymbol: symbols.includes(symbol),
    symbolCount: symbols.length
  }, null, 2));
})().catch(async (err) => {
  console.error(err);
  try { await client.quit(); } catch {}
  process.exit(1);
});
