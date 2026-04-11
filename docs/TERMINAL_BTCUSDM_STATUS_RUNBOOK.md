# Terminal BTCUSDm Status Runbook

## Current State

- Latest production deployment: `9d803119-9baf-4c8e-a1fc-8bb7a13e2c55` (`SUCCESS`)
- Latest pushed commit: `0be42b9` - `Anchor terminal to selected symbol`
- Previous related commits:
  - `00a3a81` - `Preserve terminal symbol selection`
  - `7dd6867` - `Fix symbol alias matching`
  - `90bd190` - `Fix broker symbol alias resolution`

## What Changed

### 1. Backend symbol alias fixes

The production API was patched so broker-native suffixed symbols like `BTCUSDm` resolve correctly instead of falling back to unsuffixed symbols.

Affected areas:

- `frontend/src/app/api/candles/route.ts`
- `frontend/src/app/api/symbol-spec/route.ts`

Result:

- `/api/candles` now returns real `BTCUSDm` bars for the private connection.
- `/api/symbol-spec` resolves broker-native symbol metadata correctly.

### 2. Terminal symbol selection preservation

The terminal page previously allowed the selected symbol to get overwritten by the first live symbol in the feed.

Affected area:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`

Result:

- The available symbol set now includes live quote symbols, stream symbols, and configured symbols.
- Manual symbol selection is less likely to snap back when the live feed updates.

### 3. Terminal render-path fix

The terminal page was still rendering `EURUSDm` in the active quote/chart path even after `BTCUSDm` was selected. The visible chart state was tied too closely to the live-feed fallback path.

Affected area:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`

Result:

- The page now anchors the visible terminal/chart symbol to `selectedSymbol`.
- A separate resolved live symbol is used only for quote lookup.
- The UI should no longer render `EURUSDm` just because it is the first live quote.

## MT5 Terminal Status

Exact portable terminal profile under investigation:

- `C:\mt5system\terminals\final-clean-manual\terminal64.exe`

Exact connection bound to that profile:

- `c9fc4e21-f284-4c86-999f-ddedd5649734`

Verified profile wiring:

- Relay base URL: `https://ifx-mt5-portal-production.up.railway.app/api/mt5`
- Heartbeat URL: `https://ifx-mt5-portal-production.up.railway.app/api/ea/heartbeat`
- Preset file: `C:\mt5system\terminals\final-clean-manual\MQL5\Presets\ifx_connection.set`
- Bootstrap file: `C:\mt5system\terminals\final-clean-manual\MQL5\Files\ifx\bootstrap.json`

## What Is Verified Right Now

### Verified on MT5 side

- The exact portable terminal is running.
- Heartbeats are succeeding repeatedly.
- `BTCUSDm` candle-close uploads are succeeding.
- `BTCUSDm` historical bulk pushes are succeeding.
- Fresh `BTCUSDm` reseed/sync activity is present in the MT5 logs.

Examples already observed in `C:\mt5system\terminals\final-clean-manual\MQL5\Logs\20260411.log`:

- `✅ [BTCUSDm] candle-close T=...`
- `✅ [BTCUSDm] historical bulk pushed`
- `🔄 [SYNC] BTCUSDm periodic sliding-window refresh — re-pushing last 240 bars`

Conclusion:

- `4014` is not the active blocker for this BTCUSDm issue anymore.
- The MT5 upload pipeline is alive for the affected profile.

### Verified on API side

- Production `/api/candles` returns real recent `BTCUSDm` bars for the private connection.
- The response resolves `resolved_symbol` as `BTCUSDm`.

Conclusion:

- The backend candle API is working for `BTCUSDm`.

### Verified on frontend side before latest patch

- The terminal page still displayed `EURUSDm` in the active quote/chart path after selecting `BTCUSDm`.

Conclusion:

- The remaining blocker had moved from backend/MT5 into terminal-page symbol rendering.

## Files Changed In This Investigation

Primary frontend fix:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`

Previously changed support files:

- `frontend/src/app/api/candles/route.ts`
- `frontend/src/app/api/symbol-spec/route.ts`
- `frontend/src/app/api/ea/heartbeat/route.ts`
- `runtime/terminal_manager.py`
- `frontend/src/app/(dashboard)/connections/actions.ts`
- `frontend/src/lib/ea-control-plane.ts`
- `frontend/src/app/api/terminal-host/assignment/[assignmentId]/verify/route.ts`
- `check_runtime.ps1`
- `IFX_Railway_Bridge_v1.mq5`

## Build And Deploy Status

Validated locally:

- `npm run build` in `frontend/` completed successfully after the latest terminal-page fix.

Validated remotely:

- Railway deployment `9d803119-9baf-4c8e-a1fc-8bb7a13e2c55` is `SUCCESS`.

## New Connection Behavior

### What happens when a new user adds a new MT5 connection

When a user creates a new MT5 connection, the server now tries to provision it automatically.

Current flow:

1. The app creates the `mt5_user_connections` row.
2. The app looks for an online terminal host.
3. The app creates a bootstrap assignment for that host.
4. The connection status is moved to `connecting`.
5. The terminal manager picks up the assignment.
6. The manager provisions a dedicated portable MT5 terminal for that connection.
7. The manager installs the EA, preset file, and bootstrap file.
8. The manager writes a `startup.ini` that launches MT5 with the EA already attached.
9. The manager waits for verification before acknowledging launch.

Important constraint:

- The current app logic still enforces one active MT5 connection per user.

### Where the new MT5 terminal opens

By default, a new portable MT5 terminal is created under:

- `C:\mt5system\terminals\<connection_id>`

That location comes from the runtime provisioner and is keyed by the connection id so each connection gets its own isolated MT5 data folder.

Provisioning behavior:

- If `MT5_TEMPLATE_DIR` is configured and valid, the terminal is copied from that template.
- Otherwise the provisioner copies from the broker-specific MT5 install.
- If no broker-specific install matches, it falls back to the default MetaTrader base install.

### Is the EA applied automatically

Yes, if an online terminal host exists and the terminal manager is running.

Automatic manager steps:

- install EA into `MQL5/Experts/IFX`
- write `MQL5/Presets/ifx_connection.set`
- write `MQL5/Files/ifx/bootstrap.json`
- write `startup.ini` with:
  - `Expert=<installed EA path>`
  - `ExpertParameters=ifx_connection.set`
- launch `terminal64.exe /portable /config:startup.ini`

### When auto-provisioning will not happen

Auto-provisioning depends on the local terminal host layer still being available.

It will not complete automatically if:

- no terminal host is online
- the terminal manager is not running
- the local machine does not have a valid MT5 template or base install
- connection bootstrap fails and the connection is left `offline` with an error

In that case, the connection row can still be created, but the actual MT5 terminal will not launch until the host/manager layer is healthy.

## Reducing Local Dependency

### Direction of the architecture

The system is being pushed away from a local-machine-dependent model and toward an EA + Railway model for the majority of operational work.

The goal is:

- local host only provisions and launches MT5
- EA handles market data upload, heartbeat, and scoped connection identity
- Railway handles ingest, routing, state, candles, symbol resolution, UI, and control-plane logic

### What has already moved away from the local machine

The following responsibilities are now primarily handled by the EA or Railway rather than by ad hoc local scripts:

- tick ingestion
- candle-close ingestion
- historical bulk upload
- account heartbeat and account metrics
- connection-scoped symbol/config lookup
- broker symbol alias resolution
- terminal assignment tracking
- launch verification
- terminal UI state, charting, and control-plane APIs

### What still depends on the local machine today

The local machine is still responsible for a smaller but important set of tasks:

- storing and running the MT5 terminal executable
- provisioning a portable terminal folder per connection
- launching MT5 with the EA attached
- compiling the local EA source into `.ex5` when needed
- keeping the terminal manager online so assignments can be processed

### Practical interpretation

For most runtime behavior, the system now depends more on:

- the EA running inside MT5
- Railway control-plane and API routes
- Supabase state
- Redis-backed live data and candle storage

And it depends less on:

- manual local intervention
- custom one-off local scripts
- local UI or local relay behavior for core data flow

This is the intended steady state:

- local machine = provisioning and MT5 host
- EA = on-terminal agent
- Railway = source of truth for ingest, orchestration, UI, and verification

## How To Verify Now

### Browser verification

1. Open the production terminal page.
2. Open the symbol selector.
3. Select `BTCUSDm`.
4. Confirm the following all show `BTCUSDm`:
   - side-panel symbol selector
   - tab highlight
   - `ACTIVE QUOTE`
   - chart badge `BTCUSDm ● LIVE`
   - candle chart loading for `BTCUSDm`

Expected result:

- The page should remain on `BTCUSDm` and stop rendering `EURUSDm` as the active chart symbol.

### API verification

Use the private connection id:

- `c9fc4e21-f284-4c86-999f-ddedd5649734`

Request:

- `/api/candles?conn_id=c9fc4e21-f284-4c86-999f-ddedd5649734&symbol=BTCUSDm&tf=1m&count=20`

Expected result:

- HTTP `200`
- `resolved_symbol = BTCUSDm`
- recent bars returned

### MT5 verification

Inspect the newest file in:

- `C:\mt5system\terminals\final-clean-manual\MQL5\Logs`

Search for:

- `BTCUSDm`
- `historical bulk pushed`
- `candle-close T=`
- `4014`
- `POST failed`

Expected result:

- Recent `BTCUSDm` success lines should exist.
- `4014` should not be the dominant current failure mode.

## If It Still Fails

### If the terminal page still shows `EURUSDm`

The remaining issue is still frontend-side. Inspect these exact derived values in `TerminalWorkspace.tsx`:

- `selectedSymbol`
- `resolvedSelectedSymbol`
- `displaySymbol`
- `liveQuoteSymbol`
- `livePrice`
- `quoteSymbol`
- `tabSymbols`

Focus question:

- Is `selectedSymbol` really staying on `BTCUSDm`, and is some later render path still deriving `quoteSymbol` from the first live feed symbol?

### If the chart shows `BTCUSDm` but no history

Check whether the chart component is requesting the expected symbol/timeframe pair and whether the browser session is using the correct connection id.

Files to inspect:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`
- `frontend/src/components/chart/CandlestickChart.tsx`

### If uploads stop later

Go back to the exact portable terminal profile:

- `C:\mt5system\terminals\final-clean-manual`

Check:

- MT5 Experts log
- preset/bootstrap files
- whether `WebRequest` errors have returned

Only at that point should `4014` be considered active again.

## Practical Summary

- MT5 is currently uploading `BTCUSDm` successfully.
- The backend API is currently serving `BTCUSDm` successfully.
- The work shifted from relay/data problems to terminal-page symbol-state/render problems.
- The latest render-path fix is deployed to production.
- The immediate next task is live browser verification that production now holds `BTCUSDm` end-to-end.