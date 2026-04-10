# Railway Ingest Plan

## Services

The target production topology is:

1. `ifx-mt5-ingest`
2. `Redis`
3. `ifx-mt5-portal`

## Responsibilities

### ifx-mt5-ingest

Public service for MT5 EA traffic.

Runs first in the live path:

`EA -> ifx-mt5-ingest -> Redis`

Owns:

- HMAC verification of `X-IFX-*` headers
- `/tick-batch`
- `/candle-close`
- `/historical-bulk`
- `/health`
- `/config`
- Redis writes for latest prices, forming candles, and recent 1m history

Does not own:

- browser sessions
- terminal UI rendering
- Supabase auth/session handling

### Redis

Shared canonical live-state store.

Owns:

- latest quotes per connection/symbol
- forming 1m candles
- recent closed 1m candle history
- symbol registry
- live event fan-out channels

### ifx-mt5-portal

Public web application.

Runs after ingest has already persisted data:

`Redis -> ifx-mt5-portal -> browser`

Owns:

- auth
- guest/public terminal pages
- WebSocket fan-out to browsers
- `/api/prices`, `/api/candles`, `/api/stream`
- reading live state from Redis

Does not own:

- direct EA ingestion in the final architecture
- canonical live quote storage in process memory

## Phase 1 in this repo

Phase 1 keeps the current single `ifx-mt5-portal` Railway service but prepares the split:

- add direct EA-compatible cloud routes under `/api/mt5/*`
- verify EA HMAC signatures using `RELAY_SECRET`
- dual-write incoming MT5 data to Redis and existing in-memory `mt5State`
- preserve existing `/api/mt5/ingest` bearer-token path for current relay compatibility

This is a compatibility phase, not the final separation.

## Final cut-over

When ready, create a new Railway service named `ifx-mt5-ingest` that deploys the same ingest route code on its own domain.

Then:

1. point the EA `BackendRelayUrl` to `https://<ifx-mt5-ingest-domain>/api/mt5`
2. keep `SigningSecret` equal to `RELAY_SECRET`
3. move portal reads to Redis-first
4. remove the local relay from the guest/public hot path