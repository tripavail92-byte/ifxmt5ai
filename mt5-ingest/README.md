# ifx-mt5-ingest

Dedicated MT5 cloud ingest service for Railway.

## Responsibilities

- accept EA POSTs at `/tick-batch`, `/candle-close`, `/historical-bulk`
- accept prefixed EA POSTs at `/api/mt5/*`
- verify `X-IFX-*` HMAC headers using `RELAY_SECRET`
- write latest prices, forming candles, and recent 1m history to Redis
- expose `/health` and `/config`

## Required env

- `REDIS_URL`
- `RELAY_SECRET`

## Railway

Use this service as a separate Railway service with root directory `mt5-ingest`.
Then point the EA `BackendRelayUrl` to:

`https://<service-domain>/api/mt5`