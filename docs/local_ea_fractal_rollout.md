# Local EA Fractal Rollout

This is the minimum EA-first upgrade path for local testing before any VPS rollout.

## Goal

Keep the current pricing and candle pipeline, but add one local decision primitive inside the EA:

- confirmed fractal swing high / swing low detection
- bullish break when close is above latest confirmed swing high
- bearish break when close is below latest confirmed swing low

This is intentionally smaller than the full BOS/CHOCH and risk engine migration.

## What Changed

The EA now supports these new inputs in [IFX_PriceBridge_v3.mq5](IFX_PriceBridge_v3.mq5):

- `EnableLocalFractalSignals`
- `StructureTimeframe`
- `StructurePivotWindow`
- `StructureBarsToScan`
- `LogFractalSignals`

When enabled, the EA:

- fetches closed candles for `StructureTimeframe`
- confirms swing pivots using `StructurePivotWindow`
- checks the latest closed candle against those swing levels
- logs a local event only once per closed candle

## Recommended Local Settings

Start with:

- `EnableLocalFractalSignals = true`
- `StructureTimeframe = PERIOD_M5`
- `StructurePivotWindow = 2`
- `StructureBarsToScan = 120`
- `LogFractalSignals = true`

If signals are too noisy:

- increase `StructurePivotWindow` to `3` or `4`
- move `StructureTimeframe` to `PERIOD_M15`

## Local Test Steps

1. Compile [IFX_PriceBridge_v3.mq5](IFX_PriceBridge_v3.mq5) in MetaEditor.
2. Attach the EA to one chart in MT5.
3. Confirm the Experts log prints the local fractal startup line.
4. Leave MT5 running through several closed candles on the selected structure timeframe.
5. Watch the Experts log for entries shaped like:

```text
⚡ [FRACTAL] EURUSDm 5m bullish break close=1.12345 level=1.12280 pivot_window=2 candle=2026.04.11 14:35
⚡ [FRACTAL] XAUUSDm 5m bearish break close=3210.50 level=3212.10 pivot_window=2 candle=2026.04.11 14:40
```

## What This Proves

If these events are stable, then the EA is already handling the first real piece of local market structure logic without needing Python workers.

That gives a safe migration order:

1. local fractal break detection
2. local setup state transitions
3. local stop and TP derivation from swing structure
4. local risk sizing
5. local order execution and trade management
6. cloud only for config, telemetry, audit, and update control

## Immediate Next Step After Validation

Once the log output looks correct, the next implementation step should be:

- persist the latest local structure event in EA memory
- optionally post a compact `/structure-event` payload to the cloud
- use that event as the trigger for a first local trade policy

Do not build the full BOS/CHOCH stack yet. Validate the deterministic fractal break layer first.