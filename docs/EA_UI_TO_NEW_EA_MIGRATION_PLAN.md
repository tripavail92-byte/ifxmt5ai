# EA UI To New EA Migration Plan

## Objective

Make `finaleabyahsan.txt` the source of truth for trading behavior and adapt the current IFX web UI, control plane, and MT5 runtime around it.

The target state is:

1. The frontend edits strategy, setup, and risk configuration.
2. Railway and Supabase store versioned EA configuration and commands.
3. The EA pulls that configuration and executes trades locally inside MT5.
4. The EA reports state, structure, positions, and execution audit back to Railway.
5. The backend no longer acts as the primary trade executor.

## Source Of Truth Decision

The source of truth for trading logic is now:

- `finaleabyahsan.txt`

This file matches the canonical `IFX_6Gate_Sniper_Turbo.mq5` v9.30 strategy draft.

`newEA (2).txt` is now historical reference only and must not be used as the parity target for cloud-EA work.

That means the UI must follow the v9.30 EA model, not the other way around.

This also means:

- we should not keep two separate trading brains
- we should not keep browser-side and EA-side strategy logic drifting apart
- frontend controls must map cleanly to every v9.30 EA config field
- the old `trade_jobs` worker path becomes legacy and should be phased out
- the cloud EA must become an exact behavioral port, not a reinterpretation

## Multi-User Non-Negotiables

Because this is a multi-user system, the migration must satisfy all of these constraints before rollout.

### 1. Tenant isolation is mandatory

Every runtime object must remain scoped to exactly one user connection.

That includes:

- EA config rows
- EA commands
- EA command acknowledgements
- runtime state snapshots
- trade audit rows
- terminal assignments
- terminal installations
- live subscriptions
- Redis keys or other cache keys

Minimum rule:

- every cloud object must be queryable by `connection_id`
- every user-owned table must still remain safely attributable to `user_id`
- no global shared queue should contain ambiguous trade instructions across users

### 2. One connection must map to one terminal instance

Do not allow two active execution runtimes to believe they both own the same connection.

Required guarantees:

- one `connection_id`
- one active terminal assignment
- one active EA installation token
- one active MT5 terminal folder
- one active execution owner at a time

### 3. Commands must be idempotent

The system must assume retries, duplicated polls, reconnects, and delayed acknowledgements.

Every execution-affecting command must include:

- command id
- connection id
- command type
- created timestamp
- monotonic sequence or cursor position
- idempotency key

The EA must be able to safely ignore a command it already applied.

### 4. Config apply must be versioned and acknowledged

The cloud must know which config version the EA has actually applied, not merely which version exists in the database.

Need explicit fields for:

- latest published config version
- latest applied config version
- latest reported EA binary version
- latest command cursor acknowledged by the EA

### 5. Rollout must be reversible

The migration cannot assume a one-shot cutover.

We need:

- feature flags for EA-first execution
- per-connection fallback to legacy worker path during rollout
- manager-level ability to pin a connection to a known-good EA release
- rollback path to previous EA release if a new release misbehaves

### 6. The UI must never claim execution success before EA confirmation

The frontend can show:

- requested
- pending
- acknowledged
- executed
- rejected

But it must not represent an action as completed until the EA reports the final outcome.

## Current State Summary

### What the current UI already has

The current UI already exposes many of the concepts the v9.30 EA needs, but it still contains browser-side planning and guard logic that must be removed from the authoritative execution path.

- setup zones
- AI sensitivity
- dynamic SL mode
- risk/reward controls
- max trades per day
- daily loss guardrails
- max position size
- session filters
- trade-now / armed setup flow

These exist mainly in:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`
- `frontend/src/app/(dashboard)/strategies/ManualTradeCard.tsx`
- `frontend/src/lib/structure.ts`
- `frontend/src/app/(dashboard)/strategies/actions.ts`

### What the current backend still does

The current backend still owns or participates in execution via:

- `trade_jobs`
- `runtime/job_worker.py`
- frontend actions that queue jobs instead of configuring the EA

This is the main architectural mismatch with the exact-v9.30 EA-first model.

## Immediate Correction

The current repo contains two different assumptions that must not be mixed:

- `finaleabyahsan.txt` is the canonical v9.30 trading brain.
- `MQL5/Experts/IFX_6Gate_Cloud_v1.mq5` is the modular shell that must be brought to exact parity with that brain.

From this point forward:

- all parity comparisons use `finaleabyahsan.txt`
- all implementation work lands in the cloud EA modules and related control-plane/UI code
- no product decision should be based on `newEA (2).txt` unless explicitly marked as historical reference

### What the current control plane already has

The existing control plane already provides a useful starting base:

- terminal provisioning and assignment
- EA release manifest support
- EA config storage (`ea_user_configs`)
- install-token auth
- EA registration and heartbeat endpoints
- local EA compile/install support in terminal manager

These exist mainly in:

- `frontend/src/lib/ea-control-plane.ts`
- `frontend/src/app/api/ea/config/route.ts`
- `frontend/src/app/api/ea/register/route.ts`
- `frontend/src/app/api/ea/heartbeat/route.ts`
- `runtime/terminal_manager.py`

### What is still missing for a safe multi-user rollout

The current plan still needed explicit production-grade guarantees in these areas:

- tenant isolation rules for every new table and endpoint
- command idempotency and ordering semantics
- config apply acknowledgement semantics
- release rollback and feature-flag strategy
- migration and backfill strategy from legacy rows
- observability and alerting for per-connection failures
- load and concurrency rules for many simultaneous terminals

## Target Architecture

## A. Responsibility split

### Frontend

Frontend should own:

- editing setup values
- editing risk values
- editing session filters
- editing strategy toggles
- displaying live state from the EA
- displaying preview calculations where useful

Frontend should stop owning:

- final trade execution
- final stop logic
- final structure decision logic

### Railway / Supabase

Control plane should own:

- auth
- config versioning
- command routing
- release manifest management
- audit storage
- terminal/installation registry
- events and telemetry

Control plane should stop owning:

- direct MT5 order execution as the primary path

### EA

The EA should own:

- final signal logic
- final zone logic
- final structure logic
- final stop placement
- lot sizing
- trade execution
- break-even / partial / EOD management
- reporting execution outcomes back to cloud

### Local terminal host / manager

The local machine should only own:

- terminal provisioning
- EA compilation or artifact installation
- MT5 launch / restart
- installation health checks

It must not become a hidden second trading brain.

## C. Multi-user execution contract

For each `connection_id`, the system must have exactly one authoritative execution owner.

Allowed owners during migration:

- legacy worker
- EA-first runtime

Disallowed state:

- both worker and EA acting on the same live execution intent at the same time

Implementation rule:

- add an explicit `execution_mode` or equivalent ownership marker at the connection or installation layer
- all write paths must check that marker before performing execution-affecting work

## B. Migration rule

Use this rule throughout the migration:

- config changes do not require recompiling the EA
- logic changes do require a new EA release

Examples of config changes:

- AI sensitivity
- session toggles
- risk percent
- max trades per day
- pivot / bias / tp values
- active symbols

Examples of logic changes:

- new stop algorithm
- new entry algorithm
- new structure algorithm
- new partial-close logic
- new position-management rules

## Canonical Trading Model

The current UI must be adapted to the new EA trading model.

The canonical model should be:

- symbol
- direction bias
- pivot
- TP1
- TP2
- ATR-based zone thickness
- pivot length / structure sensitivity
- stop anchor settings
- risk settings
- session rules
- execution-management rules

This means some current UI concepts can stay, but they must be reinterpreted to match the EA.

## UI Feature Mapping

## 1. Zones

### Current UI model

- `entry_price`
- `zone_percent`
- derived `zone_low` / `zone_high`

### New EA model

- `sys_pivot`
- `i_atrPct`
- derived `zoneLow` / `zoneHigh`

### Decision

The EA model wins.

We should migrate the UI from entry-centered zones to EA-centered zones.

UI changes required:

- replace or de-emphasize `Entry Price` as the primary zone anchor
- introduce `Pivot`
- introduce `Target 1`
- introduce `Target 2`
- replace `Zone Percent` wording with EA-compatible `ATR Zone Thickness %`
- show derived zone low/high as preview only

Backward compatibility option:

- temporarily keep `entry_price` in the UI as a helper field
- but do not let it be the long-term source of truth for zone generation

## 2. AI Sensitivity / Structure

### Current UI model

- `aiSensitivity`
- maps to `pivotWindow`

### New EA model

- `i_pivotLen`

### Decision

This maps cleanly.

Migration action:

- keep the UI control
- rename internally to an EA-compatible field
- send it through config as the structure sensitivity / pivot length input

## 3. Dynamic SL

### Current UI model

- browser-side `ai_dynamic` stop mode
- stop derived from frontend structure helper

### New EA model

- `i_use_mtf_sl`
- `i_sl_tf`
- `GetMTFAnchor(...)`
- `i_slPad`

### Decision

The EA must become the final stop engine.

Migration action:

- frontend may still preview a stop
- but the EA computes the final live stop
- the EA should report back the chosen stop anchor and active stop so the UI shows the real value

## 4. Risk Management

### Current UI model

- risk mode
- risk percent
- risk USD
- RR
- max trades per day
- daily loss limit
- max position size
- max drawdown
- session windows

### New EA model

- `i_riskPct`
- `i_min_rr`
- `i_maxTrades`
- `i_useDeadSL`
- `i_slCooldown`
- `i_useAutoRR`
- `i_autoRR1`
- `i_autoRR2`
- `i_usePartial`
- `i_tp1_pct`
- `i_useBE`
- `i_be_after_tp1`
- `i_useEOD`

### Decision

The UI should be adapted to expose the EA's real risk-management controls rather than a separate browser-side model.

Migration action:

- keep shared controls that already match the EA
- retire or rewrite UI-only controls that the EA cannot honor
- add missing EA controls into the UI settings model

## 5. Sessions

### Current UI model

- london
- newYork
- asia

### New EA model

- `i_useAsia`, `i_sesAsiaStart`, `i_sesAsiaEnd`
- `i_useLon`, `i_sesLonStart`, `i_sesLonEnd`
- `i_useNY`, `i_sesNYStart`, `i_sesNYEnd`

### Decision

The UI should continue exposing sessions, but it must also support the exact session time windows expected by the EA.

## 6. Trade Now / Manual trigger

### Current UI model

- arm a setup
- backend eventually queues a `trade_jobs` row

### Target model

- arm a setup or send an EA command
- EA sees the command and executes if conditions match

### Decision

Replace `trade_jobs` for this path with an EA command channel.

## Required Data Contract

Create one canonical config payload for the EA.

Suggested shape:

```json
{
  "version": 1,
  "connection_id": "uuid",
  "symbol": "BTCUSDm",
  "setup": {
    "bias": "Long",
    "pivot": 67500.0,
    "tp1": 68000.0,
    "tp2": 68600.0,
    "atr_zone_percent": 10.0,
    "trade_enabled": true
  },
  "structure": {
    "entry_timeframe": "M1",
    "boss_timeframe": "H1",
    "pivot_len": 5,
    "use_mtf_sl": true,
    "sl_timeframe": "M15",
    "be_timeframe": "M10"
  },
  "risk": {
    "risk_percent": 2.0,
    "min_rr": 1.0,
    "max_trades_per_day": 3,
    "sl_cooldown_min": 30,
    "strict_risk": false
  },
  "management": {
    "use_partial": true,
    "tp1_percent": 75.0,
    "use_break_even": true,
    "be_after_tp1": true,
    "use_eod_close": true,
    "eod_time": "23:50"
  },
  "sessions": {
    "asia": { "enabled": false, "start": "19:00", "end": "03:00" },
    "london": { "enabled": true, "start": "03:00", "end": "11:00" },
    "new_york": { "enabled": true, "start": "08:00", "end": "17:00" }
  },
  "telemetry": {
    "heartbeat_sec": 30,
    "config_poll_sec": 15
  }
}
```

Additional required metadata around this payload:

- `config_version`
- `release_channel`
- `expected_ea_version`
- `published_at`
- `published_by`
- optional `migration_source` during backfill from legacy setup rows

Important rule:

- the database row storing this config should still remain attributable to the owning user even if the EA only consumes `connection_id`

## Required New Control Plane Pieces

## 1. Config versioning

Need the EA to pull:

- current config version
- current config payload
- current EA release version

This is already partially present and must be extended, not redesigned from zero.

## 2. EA command channel

Add explicit command tables and routes.

### Tables

- `ea_commands`
- `ea_command_acks`

Minimum required fields for `ea_commands`:

- `id`
- `connection_id`
- `user_id`
- `command_type`
- `payload_json`
- `sequence_no`
- `idempotency_key`
- `status`
- `created_at`
- `expires_at`

Minimum required fields for `ea_command_acks`:

- `id`
- `command_id`
- `connection_id`
- `status`
- `ack_payload_json`
- `acknowledged_at`

### Command types

- `arm_trade`
- `cancel_trade`
- `close_position`
- `pause_symbol`
- `resume_symbol`
- `sync_config`
- `set_bias`
- `set_setup`

### Endpoints

- `GET /api/ea/commands?connection_id=...&cursor=...`
- `POST /api/ea/commands/ack`

## 3. EA runtime state reporting

Need the EA to report more than heartbeat.

Add support for:

- current active setup values
- current structure state
- current zone boundaries
- chosen stop anchor
- last execution decision
- partial / break-even / dead-SL / EOD state

Suggested storage:

- `ea_runtime_events`
- `ea_trade_audit`
- optionally `ea_runtime_state` for latest snapshot

Multi-user requirement:

- all runtime snapshots and events must be partitionable by `connection_id`
- user-facing queries must still be filtered by ownership through `user_id` or equivalent secure join path

## 4. Release rollout path

Use the existing manager support to handle real EA binary updates.

Release lifecycle:

1. MQ5 source changes
2. compile `.mq5 -> .ex5`
3. publish artifact
4. insert `ea_releases` row
5. manager detects drift
6. manager reinstalls artifact
7. MT5 restarts
8. EA re-registers and reports new version

Release safety requirements:

- rollout by release channel
- optional canary cohort before wide rollout
- ability to pin a specific connection to a release version
- ability to rollback without schema loss
- manager should not force-upgrade terminals that are actively in a sensitive execution state unless policy allows it

## Required Migration Safeguards

## 1. Backward compatibility period

We need a staged migration where the current UI and runtime keep working while EA-first execution is introduced.

Required approach:

- keep legacy `trade_jobs` path available behind a flag during rollout
- introduce EA-first mode per connection, not globally on day one
- keep existing monitoring dashboards usable during the transition

## 2. Data migration and backfill

We must explicitly migrate old state into the new config contract.

Backfill sources include:

- `trading_setups`
- `user_terminal_settings`
- existing strategy rows
- existing connection status rows

Backfill rules must define:

- how legacy `entry_price` maps into EA-native setup fields
- how legacy `zone_percent` is reinterpreted or deprecated
- how existing AI sensitivity values map into EA pivot length
- what happens when a legacy field has no direct EA equivalent

## 3. Failure-state design

We need explicit states for:

- config published but not yet applied
- command delivered but not yet acknowledged
- EA online but config stale
- EA offline while assignment is still active
- terminal manager healthy but MT5 failed to launch
- MT5 running but EA failed to register
- EA running but command stream lagging

These states must surface in UI and operator tooling.

## 4. Kill switch support

There must be at least two kill switches:

- per-connection trade disable
- global EA execution disable by environment or feature flag

These should work without recompiling the EA when possible.

## 5. Enterprise validation checklist

Before calling this rollout enterprise-ready, validate these against vendor and platform constraints, not just local design assumptions.

Need explicit validation for:

- MT5 `WebRequest()` blocking behavior and timeout budget
- MT5 URL whitelist requirements in live terminals
- degraded-mode behavior when Railway or Supabase is slow but the EA remains attached
- Supabase RLS coverage for every new table, view, and RPC path
- service-role usage boundaries so browser clients never bypass tenant isolation
- index coverage for `connection_id`, `user_id`, `sequence_no`, and stale-state queries
- release rollback behavior when the EA binary changes but config schema also evolves
- reconnect storm behavior when many terminals poll after an outage

Implementation rule:

- every new control-plane endpoint or table must have a matching validation checklist entry before production rollout

## Implementation Phases

## Phase 0 - Freeze and define the contract

Goal:

- stop further drift between UI logic and EA logic

Tasks:

1. Treat `newEA (2).txt` as the reference implementation for trading behavior.
2. Define the canonical config JSON schema.
3. Mark the current `trade_jobs` path as legacy.
4. Document which current UI controls remain, which are renamed, and which are removed.
5. Define the multi-user execution ownership rules.
6. Define the rollout feature flags and rollback criteria.

Deliverables:

- this plan
- config schema
- field mapping doc

## Phase 1 - Align frontend terminology and settings model

Goal:

- make the UI describe the EA truth instead of the legacy runtime truth

Tasks:

1. Update terminal UI labels:
   - `Zone Percent` -> `ATR Zone Thickness %`
   - `AI Sensitivity` -> `Structure Sensitivity / Pivot Length`
   - `Trade Now` messaging -> EA command language instead of `queue MT5 order`
2. Introduce explicit setup fields in UI:
   - bias
   - pivot
   - TP1
   - TP2
3. Update terminal preferences model to support EA-native settings.
4. Remove or de-emphasize browser-side logic that implies the frontend is the execution engine.

Files likely touched:

- `frontend/src/app/terminal/TerminalWorkspace.tsx`
- `frontend/src/app/(dashboard)/strategies/ManualTradeCard.tsx`
- `frontend/src/app/terminal/types.ts`

## Phase 2 - Extend control plane config contract

Goal:

- make Railway serve the exact config the EA needs

Tasks:

1. Expand `ea_user_configs.config_json` to the new schema.
2. Extend `/api/ea/config` to return EA-native config groups.
3. Add config version bumping on every relevant UI save.
4. Add migration logic from existing terminal settings and setup rows into EA config.
5. Add explicit config apply acknowledgement tracking.
6. Add ownership fields and RLS-safe query paths for new data.

Initial implementation started:

- shared EA config schema helper in the frontend control-plane layer
- normalized `/api/ea/config` response so the EA sees a stable grouped payload
- normalized register response so install-time bootstrap and runtime config use the same contract

Files likely touched:

- `frontend/src/lib/ea-control-plane.ts`
- `frontend/src/app/api/ea/config/route.ts`
- any save actions for terminal preferences and strategy settings

## Phase 3 - Add EA command channel

Goal:

- replace backend execution queue usage for interactive trade actions

Tasks:

1. Create `ea_commands` table.
2. Create `ea_command_acks` table.
3. Add API routes for command polling and acknowledgements.
4. Replace `trade_jobs` inserts for:
   - trade-now
   - manual close
   - cancel armed trade
   - manual bias changes
5. Update realtime UI subscriptions to read command and runtime event outcomes instead of job rows.
6. Add command ordering, expiry, and idempotency semantics.

Files likely touched:

- `frontend/src/app/terminal/actions.ts`
- `frontend/src/app/(dashboard)/strategies/actions.ts`
- `frontend/src/app/terminal/TerminalWorkspace.tsx`
- new `api/ea/commands/*` routes

## Phase 4 - Adapt the EA to poll config and commands

Goal:

- make the EA consume Railway config and Railway commands directly

Tasks:

1. Replace static/manual business inputs with runtime-loaded config state.
2. Implement polling for `/api/ea/config`.
3. Implement polling for `/api/ea/commands`.
4. Add config-apply logic inside the EA.
5. Add command execution and acknowledgement logic.
6. Report runtime state and execution audit back to Railway.

Expected EA responsibilities after this phase:

- load bootstrap
- register
- fetch config
- apply config
- poll commands
- execute orders
- publish audit/events

## Phase 5 - Shift execution off backend worker

Goal:

- make EA-first execution the default production path

Tasks:

1. Stop using `trade_jobs` for primary user-driven trading flows.
2. Keep `runtime/job_worker.py` only as fallback or for migration support.
3. Update UI copy and dashboards away from job-based execution language.
4. Validate that execution audit is fully sourced from the EA path.
5. Enforce per-connection execution ownership so dual execution cannot occur.

Success condition:

- a user action in the UI reaches the EA without requiring a backend order worker

## Phase 6 - Release automation and automatic effect of changes

Goal:

- make frontend config changes apply automatically without recompiling
- make code changes apply via release automation

Tasks:

1. Finalize config version polling behavior in the EA.
2. Build release pipeline for MQ5 changes.
3. Make terminal manager handle version drift and reinstall/restart.
4. Store active EA version per installation.
5. Show config version and EA version in UI.
6. Add canary rollout and rollback support.

Result:

- config changes propagate automatically through Railway
- code changes propagate through release deployment

## Detailed Task Backlog

## Backend / Control Plane

1. Extend `ea_user_configs` schema to hold EA-native configuration.
2. Add `ea_commands` table.
3. Add `ea_command_acks` table.
4. Add `ea_runtime_state` table or equivalent latest snapshot model.
5. Extend `/api/ea/config` response shape.
6. Add `/api/ea/commands` polling endpoint.
7. Add `/api/ea/commands/ack` endpoint.
8. Add `/api/ea/runtime-state` or use `/api/ea/events` for snapshots.
9. Add release/version drift checks to manager workflows.
10. Add ownership and isolation constraints to every new row shape.
11. Add feature flags for EA-first execution rollout.
12. Add per-connection execution mode ownership.
13. Add rollback metadata at the release and installation layers.
14. Add alertable stale-config and stale-command-cursor detection.

## Frontend

1. Replace legacy execution language in terminal UI.
2. Add EA-native setup editor controls.
3. Add explicit pivot / bias / TP fields.
4. Rework zone UI to match the EA model.
5. Rework AI sensitivity wording to match pivot length.
6. Rework dynamic SL panel to show EA-derived stop when available.
7. Replace `trade_jobs` subscriptions with command/audit/event subscriptions.
8. Add EA config version + EA binary version display.
9. Add per-connection execution mode visibility.
10. Show pending/applied config version separately.
11. Show stale EA / stale config / command lag health indicators.
12. Never display success before EA acknowledgement.

## EA

1. Add config poller.
2. Add command poller.
3. Add config apply layer.
4. Add runtime state reporting.
5. Add execution audit reporting.
6. Add config version tracking.
7. Add graceful handling for unsupported or missing config fields.
8. Add command cursor tracking and idempotent command application.
9. Add explicit config apply acknowledgement.
10. Add safe startup behavior when config is missing or partially invalid.
11. Add trade-disable kill switch handling.

## Terminal Manager / Local Runtime

1. Keep compile/install path in `runtime/terminal_manager.py`.
2. Add release drift detection.
3. Add reinstall and restart workflow.
4. Persist installed version and config version per connection.
5. Keep provisioning isolated per connection id.
6. Respect rollout policy and release pinning.
7. Prevent concurrent double-launch ownership of the same connection.
8. Report installation failures in a way the UI and operators can act on.

## Security Requirements

1. Install tokens must stay scoped per connection and be rotatable.
2. New endpoints must require either install-token auth or manager auth.
3. New Supabase tables must preserve RLS-safe ownership boundaries.
4. No command endpoint should allow one tenant to infer another tenant's state.
5. Release artifacts should be checksum-verified before install.

## Observability Requirements

We need per-connection visibility for:

- published config version
- applied config version
- active EA version
- latest command sequence issued
- latest command sequence acknowledged
- heartbeat freshness
- last launch failure
- last execution rejection reason

Operator alerts should trigger on:

- stale heartbeat
- stale config apply
- stale command acknowledgement
- repeated launch failure
- repeated execution rejection
- version drift that cannot self-heal

## Test Strategy

Before production cutover, test all of these:

1. Single-user happy path end to end.
2. Multiple concurrent users with isolated configs and commands.
3. Duplicate command delivery.
4. EA reconnect after network loss.
5. Config change while EA is online.
6. Release upgrade and rollback.
7. Manager restart during assignment processing.
8. Supabase/Railway transient failure while EA continues running.
9. Legacy fallback path for one connection while EA-first is enabled for another.
10. No-cross-tenant data visibility in UI and API responses.

## Legacy Components To Decommission

These should move to legacy or fallback status:

- primary use of `trade_jobs`
- primary use of `runtime/job_worker.py` for execution
- frontend messaging that says the runtime will queue an MT5 order
- browser-side logic pretending to be the final execution engine

## Acceptance Criteria

The migration is complete when all of these are true:

1. A user changes trading settings in the UI and the EA applies them without recompilation.
2. A user-triggered trade action reaches the EA through Railway config/commands, not the backend job worker.
3. The EA is the only final execution engine for the primary path.
4. UI shows the real stop, setup, and execution state reported by the EA.
5. A new EA code change can be released through artifact + manifest + manager rollout.
6. New connections still auto-provision terminals and auto-install the EA.
7. Two different users cannot affect each other through shared command, config, cache, or runtime paths.
8. The system can rollback a bad EA release without losing per-user state.
9. Duplicate commands do not cause duplicate execution.
10. Operators can tell which connections are stale, degraded, or mismatched.

## Recommended Execution Order

Do the migration in this order:

1. Contract and schema
2. Frontend terminology alignment
3. Config endpoint expansion
4. EA command channel
5. EA config/command polling
6. Trade path migration away from `trade_jobs`
7. Release automation

This order keeps the system operable while shifting source of truth toward the EA.

## Immediate Next Step

The first implementation task should be:

- define and implement the exact `ea_user_configs.config_json` schema that maps the current terminal UI onto the new EA model

Without that contract, frontend work and EA work will continue to drift.