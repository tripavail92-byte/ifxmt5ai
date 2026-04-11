# EA Terminal Execution Master Plan

## Objective

Build a system where a new connection can move through this full lifecycle reliably:

1. Create a new MT5 connection in the web app.
2. Open or provision a dedicated MT5 terminal for that connection.
3. Apply the correct IFX EA and connection-specific settings.
4. Confirm the EA is alive and bound to the right connection.
5. Push user strategy and risk configuration from web to the EA.
6. Let the EA detect signals and execute trades successfully.
7. Report heartbeats, events, positions, and execution results back to cloud.

This plan is for the new system, not a partial patch.

## Non-Negotiable Design Rules

### 1. One connection = one terminal = one EA instance

Never share one MT5 data folder across multiple user connections.

### 2. EA does the trading brain

The target system is:

- EA handles signal logic, risk sizing, order placement, trade management
- cloud handles auth, config, release management, audit, telemetry, and UI

### 3. Cloud cannot directly inject into a user-owned MT5 without a local agent

If MT5 runs on a user machine or VPS you do not control, automatic install/update requires a local launcher or agent.

### 4. Local-first before VPS

First make the full workflow work on one local Windows machine end-to-end. Then move the same pattern to VPS.

## Current Assets We Will Reuse

The existing codebase already has strong pieces that should stay:

- [IFX_PriceBridge_v3.mq5](IFX_PriceBridge_v3.mq5): pricing, candles, signed cloud relay, local fractal seed logic
- [runtime/provision_terminal.py](runtime/provision_terminal.py): isolated per-connection portable MT5 folder provisioning
- [runtime/job_worker.py](runtime/job_worker.py): current MT5 login and trade execution path
- [runtime/db_client.py](runtime/db_client.py): heartbeat and job persistence model
- [runtime/price_relay.py](runtime/price_relay.py): relay and event funnel

These are not discarded. They are reorganized into a cleaner control-plane plus EA-first execution system.

## Target Architecture

## A. Local Host Mode: first implementation target

This is the system to build now on one Windows machine.

Components:

1. Web portal
2. Control plane API
3. Local IFX Terminal Manager service
4. Dedicated MT5 portable terminal per connection
5. IFX EA package and preset per connection
6. Supabase tables for config, release, installation, heartbeats, and audit

Flow:

1. User creates connection in portal.
2. Control plane creates connection bootstrap record.
3. Local Terminal Manager sees a pending terminal assignment.
4. Local Terminal Manager provisions a portable MT5 folder.
5. Local Terminal Manager writes connection-specific EA preset and metadata.
6. Local Terminal Manager installs EA binary into the terminal folder.
7. Local Terminal Manager launches MT5 in portable mode.
8. EA starts, loads config, registers heartbeat.
9. Portal marks terminal as online and executable.
10. EA takes over signal generation and trade execution.

## B. User-owned Host Mode: future deployment target

Same architecture, but the Local Terminal Manager becomes a tiny installed launcher on the customer machine or VPS.

That launcher will:

- poll for assignments
- download EA releases
- write presets
- open MT5
- restart MT5 for binary updates

The control plane and EA contract stay the same.

## Core New Components To Build

## 1. IFX Terminal Manager

This is the missing piece.

Responsibility:

- poll control plane for pending connection bootstrap work
- provision terminal folder
- install EA and preset files
- launch MT5
- verify terminal and EA came online
- restart or repair if broken

This replaces the current pattern where a Python worker is both provisioner and executor.

The manager must own:

- terminal lifecycle
- EA deployment lifecycle
- health verification lifecycle

It should not contain trading strategy logic.

### Local implementation

Build it first as a Python Windows service or long-running process inside this repo.

Suggested file target:

- `runtime/terminal_manager.py`

It will reuse logic from [runtime/provision_terminal.py](runtime/provision_terminal.py) and part of [runtime/job_worker.py](runtime/job_worker.py).

## 2. EA Config Contract

The EA must stop depending on manual hardcoded inputs for business logic.

Split settings into two groups.

### Static bootstrap settings

Written once into preset or installation manifest:

- `BackendRelayUrl`
- `ConnectionId`
- `SigningSecret`
- `InstallToken`
- `ReleaseChannel`
- `ConfigPollSec`

### Dynamic strategy settings from cloud

Fetched by EA on interval:

- symbols
- structure timeframe
- pivot window / AI sensitivity
- side mode or allowed direction
- risk percent
- max daily loss
- max open trades
- stop method
- tp method
- trailing rules
- break-even rules
- session filter
- news filter
- trade enable flag

These must be stored in a single versioned JSON payload.

## 3. EA Release Service

Need one source of truth for released EA binaries.

Each release record must contain:

- release id
- semantic version
- file path or signed download URL
- checksum
- minimum launcher version
- migration notes
- release channel

Binary updates are handled by Terminal Manager, not by the EA itself.

## 4. Installation Registry

Need a first-class installation object.

Each installation links:

- user id
- connection id
- terminal host id
- local terminal path
- EA version
- config version
- status
- last heartbeat

Without this, the system cannot answer basic operational questions.

## Data Model Additions

Add these tables.

### `ea_installations`

- `id`
- `user_id`
- `connection_id`
- `host_id`
- `terminal_path`
- `ea_version`
- `config_version`
- `status`
- `last_seen_at`
- `last_error`
- `created_at`

### `ea_releases`

- `id`
- `version`
- `channel`
- `artifact_url`
- `sha256`
- `is_active`
- `created_at`

### `ea_user_configs`

- `id`
- `connection_id`
- `version`
- `config_json`
- `is_active`
- `created_at`

### `terminal_hosts`

- `id`
- `host_name`
- `host_type` (`local`, `vps`, `customer-agent`)
- `status`
- `capacity`
- `last_seen_at`

### `terminal_assignments`

- `id`
- `connection_id`
- `host_id`
- `status`
- `install_token`
- `assigned_at`
- `activated_at`

### `ea_runtime_events`

- `id`
- `connection_id`
- `event_type`
- `payload`
- `created_at`

### `ea_trade_audit`

- `id`
- `connection_id`
- `symbol`
- `side`
- `entry`
- `sl`
- `tp`
- `volume`
- `decision_reason`
- `broker_ticket`
- `status`
- `created_at`

## Control Plane API

Need explicit endpoints.

### Terminal Manager endpoints

- `POST /terminal-host/register`
- `POST /terminal-host/heartbeat`
- `GET /terminal-host/assignments?host_id=...`
- `POST /terminal-host/assignment/:id/ack`
- `POST /terminal-host/assignment/:id/fail`

### EA bootstrap endpoints

- `POST /ea/register`
- `POST /ea/heartbeat`
- `GET /ea/config?connection_id=...&version=...`
- `POST /ea/events`
- `POST /ea/trade-audit`

### Release endpoints

- `GET /ea/release-manifest?channel=stable`
- `GET /ea/download/:release_id`

## Full Lifecycle: New Connection

This is the required end-to-end sequence.

### Step 1. User creates connection

Portal stores:

- broker server
- account login
- encrypted password if needed for managed-host mode
- one active connection row

### Step 2. Control plane creates bootstrap package

Control plane creates:

- `connection_id`
- `install_token`
- initial `ea_user_configs` row version `1`
- `terminal_assignments` row with status `pending`

### Step 3. Terminal Manager claims assignment

Manager chooses or receives a host assignment and marks it `provisioning`.

### Step 4. Provision MT5 terminal

Reuse the model already present in [runtime/provision_terminal.py](runtime/provision_terminal.py):

- create `terminals/<connection_id>/`
- copy broker-specific MT5 base folder
- ensure portable mode marker exists
- validate `terminal64.exe`

### Step 5. Install EA assets

Manager downloads or copies:

- `IFX_PriceBridge_v3.ex5`
- `ifx_connection.set`
- optional symbol list preset

Manager writes the preset with:

- `ConnectionId`
- `BackendRelayUrl`
- `SigningSecret`
- install token
- config polling settings
- any non-sensitive defaults

### Step 6. Launch MT5 terminal

Manager launches the provisioned terminal in portable mode and opens a dedicated chart profile for the EA.

Manager must own this launch path and record:

- process id
- path
- launch time
- retries

### Step 7. EA startup and registration

On `OnInit`, the EA must:

1. validate bootstrap fields
2. register to cloud
3. fetch current config
4. select required symbols
5. start timer loop
6. begin heartbeats

Only after a successful heartbeat should the portal show the terminal as operational.

### Step 8. Config sync

EA polls for config version changes every N seconds.

If config version changed:

1. fetch new config
2. validate config
3. apply dynamic settings in memory
4. acknowledge new version

No MT5 restart for config-only changes.

### Step 9. Live signal generation

EA performs:

- market data tracking
- fractal / structure detection
- setup state transitions
- stop and target derivation
- risk sizing
- order qualification

### Step 10. Trade execution

EA places the trade directly through MT5.

Execution success requires:

- symbol selected and tradable
- broker connected
- enough margin
- normalized SL and TP
- idempotency marker on order comment

This logic partly exists today in [runtime/job_worker.py](runtime/job_worker.py). The same validations should be moved into the EA-side execution layer.

### Step 11. Audit and monitoring

EA posts back:

- heartbeats
- structure events
- trade attempt events
- success or failure reason
- broker ticket
- balance/equity snapshot

## Full Lifecycle: Trade Execution

The exact runtime rule for successful execution must be:

1. EA receives latest config.
2. EA computes local signal on a closed candle or defined tick rule.
3. EA validates global enable flags and session filters.
4. EA validates risk constraints.
5. EA computes order shape.
6. EA normalizes symbol and stops.
7. EA sends order.
8. EA verifies broker acceptance.
9. EA records ticket and audit payload.
10. EA manages the trade after fill.

## Trade Management Must Move Into EA

Successful execution is not just sending one order. The EA must also own:

- break-even movement
- trailing stop
- partial close
- position close on invalidation
- max daily risk enforcement
- max concurrent trade enforcement

This is what makes the system complete.

## Failure Handling Plan

Need deterministic recovery rules.

### Terminal bootstrap failure

- assignment status = `failed_provision`
- save exact error
- allow manual retry from portal

### MT5 launch failure

- terminal manager retries with backoff
- if still failing, mark `failed_launch`

### EA not detected after launch

- verify preset path
- verify EA file exists
- verify chart profile launch
- verify WebRequest allow-list prerequisites
- mark `failed_registration`

### Config apply failure

- keep last good config
- post runtime error
- do not trade until config is valid

### Trade send failure

- capture broker retcode
- audit exact request and normalized levels
- optionally retry only when failure class is safe

### Terminal corruption

- backup folder
- reprovision terminal
- reinstall latest stable EA

## Security Model

### Managed local host mode

If the machine is yours, cloud can store encrypted broker password and manager can decrypt it locally for MT5 login.

### Customer-owned host mode

Prefer local-only credential storage when possible.

Cloud should hold:

- installation token
- config
- release channel

Cloud should not require raw broker password unless managed login is part of the product.

## Local-First Build Plan

Build in this order.

### Phase 1. Terminal bootstrap

Deliverable:

- `runtime/terminal_manager.py`
- create terminal folder
- install EA preset
- launch MT5
- confirm heartbeat from EA

Definition of done:

- new connection creates a live MT5 terminal automatically on local machine

### Phase 2. EA config sync

Deliverable:

- `GET /ea/config`
- EA polls config version
- portal can change structure settings and risk values

Definition of done:

- config change in web is visible inside EA without reinstall

### Phase 3. EA-first execution

Deliverable:

- EA places real orders under a guarded test mode
- execution audit returns to cloud

Definition of done:

- one test strategy can place, track, and close real trades correctly

### Phase 4. Remove worker dependency for normal execution

Deliverable:

- current job-worker path becomes fallback or admin-only

Definition of done:

- standard live trading no longer depends on Python worker execution loop

## Minimum Features Required Before VPS Rollout

Do not move to VPS until all of these are true locally.

1. A new connection automatically provisions a terminal.
2. EA is installed automatically.
3. EA heartbeats appear in portal.
4. Portal config changes reach EA.
5. EA can execute a controlled test trade successfully.
6. EA can report broker ticket and result back.
7. Restarting the machine restores the terminal and EA automatically.

## Exact Build Decision

The correct new system is:

- local or VPS Terminal Manager opens MT5 and installs EA
- EA becomes the execution engine
- cloud becomes the control plane

Not this:

- cloud making every trade decision in Python forever
- UI pretending to be the runtime
- one shared terminal servicing many user accounts

## Definition Of Complete Working System

The system is complete only when this exact acceptance test passes:

1. User adds a connection in portal.
2. System provisions a dedicated MT5 terminal automatically.
3. System installs the correct EA and per-connection preset automatically.
4. MT5 launches and EA registers successfully.
5. User changes a risk or structure parameter in web.
6. EA receives the new config automatically.
7. Market condition triggers a valid local signal.
8. EA places a trade successfully.
9. Portal shows the trade, broker ticket, and audit result.
10. Restart of terminal or host recovers without manual reinstallation.

That is the target to build toward.