# IFX Manual Terminal Audit

**Date:** 2026-03-28  
**Scope:** Compare the current live system against the target IFX Manual Terminal spec and identify what already exists, what is partial, what is missing, and what should be built next.

---

## 1. Executive Summary

### Implementation update after this audit

The repo now also includes a real live terminal route in the Next.js frontend:

- [frontend/src/app/terminal/page.tsx](frontend/src/app/terminal/page.tsx)
- [frontend/src/app/terminal/TerminalWorkspace.tsx](frontend/src/app/terminal/TerminalWorkspace.tsx)

This route now provides a trader-facing shell that is wired to the live system for:
- live MT5 chart/feed
- `trade_jobs` queue submission
- setup monitor / setup-state updates
- `Trade Now` arming
- MT5 runtime heartbeat/account snapshot

So the product has moved from **audit-only** into an actual first-pass `/terminal` implementation.

There are **two different frontend tracks** in this repo:

1. **Live production frontend** in `frontend/`  
	This is a working Next.js + Supabase app focused on:
	- auth
	- MT5 connection management
	- runtime/admin monitoring
	- manual trade queueing
	- setup monitoring (`IDLE` / `STALKING` / `PURGATORY` / `DEAD`)
	- chart + zone overlays
	- `Trade Now` arming

2. **Visual manual-terminal prototype** in `Forex Trading Terminal UI/`  
	This is much closer to the target IFX Manual Terminal look and feature layout:
	- 3-panel desktop terminal
	- mobile bottom nav
	- dedicated left/chart/right panel composition
	- positions tab
	- copy trading tab
	- terms modal
	- richer right-sidebar risk controls

### Bottom line

The **backend/runtime foundation is stronger than the current live UI**.  
The **prototype UI is stronger than the current live UX**.

So the right strategy is **not to redesign from scratch**. The right strategy is:

> **Port and merge the prototype terminal UI into the live Next.js frontend, then wire it to the existing backend/runtime services already in place.**

---

## 2. What Already Exists in the System

### 2.1 Trading setup + zone engine

This part is real and already working.

Current system supports:
- `entry_price`
- `zone_percent`
- `zone_low`
- `zone_high`
- `loss_edge`
- `target`
- `timeframe`
- `ai_sensitivity`
- `trade_now_active`

These are defined through the `trading_setups` flow and `upsert_trading_setup()` RPC.

### 2.2 State machine exists

The setup lifecycle exists and is operational:

- `IDLE`
- `STALKING`
- `PURGATORY`
- `DEAD`

Behavior:
- tick enters zone -> `STALKING`
- wick breaches loss edge -> `PURGATORY`
- H1 close confirms invalidation -> `DEAD`
- later safe H1 close can resurrect to `IDLE` or `STALKING`

### 2.3 Structure engine exists

The structure detector exists and is active:
- swing high / swing low detection
- break-up / break-down logic
- `BOS` and `CHOCH` mapping
- per-setup structure event logging into `setup_structure_events`

### 2.4 Trade execution path exists

Trade execution is already implemented through:

`frontend/server action` or `setup_manager`  
-> insert into `trade_jobs`  
-> runtime worker claims job  
-> `mt5.order_send()` executes it

So the execution backbone is already there.

### 2.5 Live chart data path exists

The live Next.js frontend already has:
- SSE price feed hook
- MT5 ingest endpoint
- candle API
- `lightweight-charts` integration
- live forming candle updates
- historical candle fetch
- zone overlays / SL / TP lines

This is a major strength of the current live app.

---

## 3. Key Clarification: What `AI_SENSITIVITY` Currently Does

This was an important audit item.

### Current truth in the live system

`AI_SENSITIVITY` currently controls **structure sensitivity**, not risk management stop-loss sizing.

In the live setup system, it maps directly to the structure pivot window:

$$
	ext{pivot\_window} = \text{AI\_SENSITIVITY}
$$

Meaning:
- lower sensitivity value -> smaller pivot window -> more sensitive structure detection
- higher sensitivity value -> larger pivot window -> less sensitive structure detection

### What it does **not** currently do

`AI_SENSITIVITY` does **not** currently drive:
- risk %
- lot size
- SL distance in the live Next.js frontend
- AI dynamic stop loss in the production frontend

### Planned next step

This is still a required follow-up item:

> wire `AI_SENSITIVITY` into the future AI stop model / live risk-management stop logic

That has **not** been completed yet.

### What currently drives SL in the setup monitor flow

For the setup/state-machine flow:
- `zone_low` / `zone_high` are derived from `entry_price + zone_percent`
- `loss_edge` is derived from the setup side
  - BUY -> `loss_edge = zone_low`
  - SELL -> `loss_edge = zone_high`

So right now:

$$
SL_{setup} = loss\_edge(entry\_price, zone\_percent, side)
$$

not:

$$
SL_{setup} = f(AI\_SENSITIVITY)
$$

### Prototype expectation vs live behavior

Your target UI/prototype expects `AI Sensitivity` and “AI Dynamic” stop-loss mode to feel connected.  
That connection is **not fully implemented** in the live production app yet.

So this is a real gap.

---

## 4. Key Clarification: Does Every Structure Break Place a Trade?

**No.**

A structure break alone does **not** automatically place a trade in the live system.

### Current live rule

A trade is queued only when all of the following are true:

$$
	ext{state} = STALKING \land \text{structure break matches setup direction} \land trade\_now\_active = true
$$

So the live behavior is:

- `STALKING` + structure break -> structure event is logged
- `STALKING` + structure break + `trade_now_active=true` -> `trade_jobs` row is inserted
- worker then executes the queued job in MT5

### Implication

Current system supports **armed one-shot structure-triggered execution**, not fully autonomous always-on execution for every setup.

That distinction is important.

---

## 5. Current Live Frontend Audit (`frontend/`)

## 5.1 Overall assessment

The live frontend is currently an **operations/admin dashboard with a useful trading card**, not yet a full institutional manual terminal.

### Current strengths
- real auth and session flow
- real MT5 connection management
- real live price/candle feed
- real chart rendering with overlays
- real manual trade queueing
- real setup monitor and state display
- real `Trade Now` arming
- real trade history and runtime logs

### Current weaknesses
- no 3-panel terminal shell
- no dedicated terminal route
- nav is admin-oriented, not trader-oriented
- no integrated right-side risk workstation
- no terms gating for execution
- no sessions/news filter UI in live app
- no copy trading UX in live app
- no live positions workstation in terminal style
- mobile experience is not yet the target product experience

---

## 6. Prototype UI Audit (`Forex Trading Terminal UI/`)

This folder contains the **closest representation of the intended IFX Manual Terminal product**.

Prototype modules confirmed present:
- `TopBar`
- `LeftSidebar`
- `ChartPanel`
- `RightSidebar`
- `DesktopNav`
- `BottomNav`
- `Positions`
- `CopyTrading`
- `ManualTrades`
- `TermsAndConditions`

### Prototype strengths
- matches target visual direction much better
- already composed into desktop 3-panel + mobile layout
- includes trader-oriented nav model
- includes richer risk/sidebar controls
- includes positions/copy/manual tabs
- includes terms modal

### Prototype limitations
- mostly visual / mocked
- not wired to real MT5 data or Supabase in many areas
- chart was planned as fake/hardcoded initially
- positions are mock
- copy trading is mock
- risk controls are local state only

### Strategic conclusion

The prototype should be treated as a **UI asset library to port into the Next.js app**, not as a separate competing product.

---

## 7. Feature-by-Feature Comparison Matrix

Status legend:
- **Implemented** = present and substantially wired
- **Partial** = UI exists or backend exists, but not both
- **Missing** = not meaningfully present in the live product flow

| Area | Target | Live `frontend/` | Prototype UI | Audit verdict |
|---|---|---|---|---|
| Auth | login/session | Implemented | N/A | Implemented |
| MT5 connection management | add/remove terminal | Implemented | Not core | Implemented |
| Real live chart | TradingView-style candles | Implemented | Partial/fake plan | Implemented |
| Entry zone overlays | entry/TP zones on chart | Implemented | Implemented visually | Implemented |
| Manual trade queueing | buy/sell to MT5 | Implemented | Visual only | Implemented |
| Setup monitor | monitor entry zone/state machine | Implemented | Not core | Implemented |
| Structure detection | CHOCH/BOS | Implemented | Implied only | Implemented |
| Structure-triggered trade | armed one-shot | Implemented | Implied | Implemented |
| 3-panel desktop terminal | left/chart/right workstation | Missing | Implemented visually | Partial overall |
| Mobile bottom-nav terminal | trader-oriented mobile UX | Missing | Implemented visually | Partial overall |
| Trader nav | AI / Positions / Copy / Manual | Missing | Implemented | Missing in live app |
| Right-sidebar risk workstation | full risk panel | Missing | Implemented visually | Partial overall |
| Risk persistence | save risk rules | Partial | Missing | Partial |
| Risk enforcement | max trades/day etc | Partial backend pieces | Missing | Partial |
| Risk % / Risk $ toggle | live in terminal | Missing | Implemented visually | Missing in live app |
| AI dynamic SL mode | UI + actual backend behavior | Missing | Implemented visually | Partial in live `/terminal`, not runtime-enforced end-to-end |
| Terms & Conditions gate | mandatory before MT5 | Missing | Implemented | Missing in live app |
| Sessions manager | London/NY/Asia toggles | Missing | Implemented visually | Missing |
| News filter UI | pre/post event blocking | Missing | Implemented visually | Missing |
| News enforcement | execution block around events | Missing | Missing | Missing |
| Positions workstation | live open positions | Missing terminal-style | Implemented visually only | Partial overall |
| Position management | close/partial/breakeven/trailing | Missing | Visual only | Missing |
| Copy trading | follow/copy traders | Missing | Visual only | Missing |
| Performance analytics | win rate / curve / metrics | Partial via raw data pages | Visual partial | Partial |
| Multi-order types | market/limit/stop/stop-limit | Missing | Visual concept | Missing |
| One-click trading | fast execution mode | Missing | Visual concept | Missing |
| Multiple TP levels | advanced exits | Missing | Missing | Missing |
| Responsive terminal UX | desktop + mobile optimized | Partial | Strong | Partial overall |

---

## 8. Gap Analysis by Product Area

## 8.1 Left panel / order-entry workstation

### Already present in live app
- symbol selection
- side selection
- entry price
- zone percent
- AI sensitivity slider
- zone visibility toggles
- monitor setup button
- `Trade Now` button
- manual `Place Trade`

### Missing vs target
- order type selector (`market`, `limit`, `stop`, `stop-limit`)
- quick lot presets
- one-click mode
- proper trader-style layout
- integrated zone confidence / AI signal confidence from real signal source
- level-touch entry behavior in live terminal UX
- richer left sidebar composition from prototype

### Verdict
Current live left-side functionality is **usable but not product-complete**.

---

## 8.2 Center chart panel

### Already present in live app
- real candlestick chart
- timeframe switching (`M1` to `D1` currently)
- live updates via SSE
- broker-native candles
- entry/SL/TP overlays

### Missing vs target
- terminal-style top toolbar polish
- full timeframe set including `W1` / possibly `MN`
- indicator stack (MA, RSI, MACD, Bollinger)
- drawing tools
- visible bid/ask/spread HUD
- richer price cards and market metadata

### Verdict
This is one of the strongest live pieces technically, but it still needs **visual and analytical feature expansion**.

---

## 8.3 Right risk-management sidebar

### Already present in live app
- almost nothing in dedicated UI form
- some backend risk foundation exists elsewhere (`user_strategies`, lot calculation, max trades/day logic in AI scheduler path)

### Missing vs target
- dedicated right sidebar panel
- risk % / risk $ mode
- max trades/day control in live terminal
- max position size
- daily loss limit
- daily profit target
- drawdown controls
- R:R live UI workstation
- AI dynamic/manual SL mode in live terminal
- session manager UI
- news filter UI
- MT5 auto-execution toggle in terminal
- terms acceptance gating
- persistent “Start Trading” profile workflow

### Verdict
This is the **largest live-UI gap** relative to your spec.

---

## 8.4 Positions and trade management

### Already present in live app
- trade history page
- queued/executed job visibility

### Missing vs target
- true positions workstation page matching terminal UX
- live P&L cards
- modify SL/TP tools
- close-position tools
- partial close
- break-even automation
- trailing stop activation

### Verdict
The current `/trades` page is an **operations table**, not a positions terminal.

---

## 8.5 Copy trading

### Live app
- absent

### Prototype
- visually present

### Verdict
Completely missing in real product terms.

---

## 8.6 Legal / terms acceptance

### Live app
- absent

### Prototype
- present

### Verdict
Needs to be ported and enforced before MT5 auto-execution enablement.

---

## 8.7 Sessions and news filters

### Live app
- absent in frontend terminal UX
- no confirmed live enforcement path implemented end-to-end

### Prototype
- present visually in right sidebar

### Verdict
Missing in the actual product.

---

## 9. Architecture Mismatch: Current Product vs Intended Product

### Current product identity
The live Next.js app behaves like:

> **IFX Runtime Control Portal**

It is very good for:
- connections
- runtime health
- queue management
- monitoring
- basic charting and manual queueing

### Intended product identity
Your target product is:

> **IFX Manual Terminal**

This is a much more trader-native terminal experience with:
- persistent workstation layout
- trader navigation
- dense execution tools
- risk cockpit on the right
- positions and copy-trading tabs
- mobile-first terminal ergonomics

### Conclusion
The current live frontend is **not the wrong project**, but it is **the wrong presentation layer** for the intended product.

---

## 10. Recommended Build Strategy

## Recommendation: Merge, do not rebuild

### Best path
Create a new route in `frontend/`, for example:

- `/terminal`

Then port the prototype modules into the live Next.js app:
- `TopBar`
- `DesktopNav`
- `BottomNav`
- `LeftSidebar`
- `ChartPanel`
- `RightSidebar`
- `Positions`
- `ManualTrades`
- `CopyTrading`
- `TermsAndConditions`

Wire them to the existing live systems:
- chart -> existing `CandlestickChart` + `/api/candles` + `usePriceFeed()`
- manual trades -> existing `placeManualTrade()`
- setup monitor -> existing `upsert_trading_setup()` + `SetupStatePanel` logic
- structure-triggered execution -> existing `Trade Now` flow
- trades -> existing `trade_jobs` / runtime worker
- MT5 status -> existing heartbeats + connections tables

### Why this is best
- backend/runtime work already exists
- chart/feed work already exists
- prototype visual design already exists
- avoids duplicate apps long term
- gives fastest path to a real product

---

## 11. Recommended UI Changes

## Phase A — Immediate UI restructuring

1. Add `/terminal` route to the live Next.js app
2. Replace admin sidebar experience with trader terminal shell on that route
3. Keep current dashboard/admin pages for ops users
4. Reuse live chart instead of prototype fake chart
5. Reuse live trade actions instead of prototype alerts

## Phase B — Right-sidebar integration

Port these prototype panels first:
- Risk management block
- Max trades/day block
- Risk % / Risk $ toggle
- R:R block
- session toggles
- news filter panel
- terms modal

Even if some controls are initially display-only, the UX shell should be established.

## Phase C — Positions and copy pages

Port the prototype screens and wire incrementally:
- positions -> real live DB/runtime data
- copy trading -> initially visual-only or feature-flagged

---

## 12. AI Sensitivity Product Recommendation

Because your intent is that `AI Sensitivity` should feel tied to entry logic and stop logic, I recommend explicitly defining two separate concepts:

### Option A — Keep one knob, broaden its effect

`AI Sensitivity` controls:
- structure pivot window
- optional stop-loss expansion/contraction
- maybe zone width scaling

This is simple for users but couples many behaviors to one setting.

### Option B — Split into two knobs

1. `Structure Sensitivity`  
	controls break-of-structure / CHOCH / BOS detection

2. `AI Stop Model` or `SL Aggression`  
	controls stop placement style

This is cleaner architecturally and avoids confusion.

### Audit recommendation

For the actual product, **Option B is safer**.

Right now users can easily assume the current `AI Sensitivity` slider changes SL behavior, but in the live system it does not. That is a UX mismatch.

---

## 13. Target Risk-Management Operating Model

This is how the risk system should work in the target IFX Manual Terminal.

### 13.1 Core principle

Risk management should be a **gating system**, not just a calculator.

That means the terminal should not only show risk numbers. It should decide whether a trade is:

- allowed
- blocked
- reduced in size
- paused because of account/session/news constraints

### 13.2 Order of operations

For every trade, the flow should be:

1. define entry model
2. define stop model
3. calculate stop distance
4. calculate risk amount
5. derive lot size from the stop distance and risk amount
6. validate all account-level guardrails
7. only then allow queueing/execution to MT5

This is the key rule:

> **Lot size must be the output of risk management, not the input that bypasses it.**

### 13.3 Stop-loss model

The product spec implies the terminal should support at least three stop styles:

1. `Manual SL`
	user enters stop directly in price or pips

2. `Zone / Setup SL`
	stop is taken from the setup invalidation model
	- BUY -> below `zone_low` / `loss_edge`
	- SELL -> above `zone_high` / `loss_edge`

3. `AI Dynamic SL`
	stop is derived from confirmed structure swings using the same `AI_SENSITIVITY` -> `pivot_window` mapping used by the structure engine
	- BUY -> stop goes below the latest confirmed swing low / break structure low
	- SELL -> stop goes above the latest confirmed swing high / break structure high
	higher `AI_SENSITIVITY` means a larger pivot window, which usually means the SL anchors to a broader structure point and becomes wider

So the base idea should be:

$$
SL_{distance} = |entry - stop|
$$

and then lot size is derived from that distance.

### 13.4 How `AI_SENSITIVITY` should interact with risk

The important product rule is:

> `AI_SENSITIVITY` should never directly increase monetary risk by itself.

If you choose to connect it to stop behavior, it should affect the **stop model**, not the risk budget.

That means the safe chain is:

$$
AI\_SENSITIVITY \rightarrow SL\ model \rightarrow SL\ distance \rightarrow lot\ size
$$

not:

$$
AI\_SENSITIVITY \rightarrow higher\ risk\ amount
$$

So if higher AI sensitivity makes the stop wider, the lot size must go **down** to keep the same account risk.

### 13.5 Position sizing rule

The target terminal should support both risk modes from your spec:

- `Risk %`
- `Risk $`

The formulas should be:

$$
risk\_amount = equity \times \frac{risk\_percent}{100}
$$

or

$$
risk\_amount = fixed\_dollar\_risk
$$

Then:

$$
lot\_size = \frac{risk\_amount}{SL_{pips} \times pip\_value\_per\_lot}
$$

Then clamp to broker/account constraints:

- min lot
- lot step
- max lot
- user max position size

This is already directionally consistent with [risk_engine/lot_calculator.py](risk_engine/lot_calculator.py).

### 13.6 Account-level guardrails

Before any order is sent or queued, the terminal should enforce these checks:

- max trades per day
- max open trades
- max lot size / max position size
- daily loss limit
- optional daily profit target lockout
- max drawdown limit
- minimum and maximum R:R rules
- MT5 connection healthy
- terms accepted
- session enabled
- news filter allows trading

If any one of these fails, the trade should be blocked before it reaches `trade_jobs`.

### 13.7 Session and news controls

From your product spec, sessions/news are not cosmetic controls. They are risk controls.

So behavior should be:

- if current session is disabled -> do not allow new trades
- if high-impact news block window is active -> do not allow new trades
- existing positions can still be monitored/managed
- only new entries are paused unless user explicitly overrides

### 13.8 Trade-now and structure-triggered execution

For `Trade Now` / armed setup execution, risk checks must happen **twice**:

1. when the setup is armed
2. again at the moment the structure trigger fires

Reason:
- equity may have changed
- trade count may have changed
- session/news status may have changed
- MT5 connection may no longer be healthy

So the trigger path should be:

`setup armed` -> `structure event occurs` -> `re-run risk checks` -> `insert trade_job`

not:

`setup armed` -> `blind fire later`

### 13.9 Post-entry risk management

After entry, the risk system should continue managing the trade through optional automation:

- break-even move
- trailing stop
- partial close levels
- quick-close controls
- modify SL/TP

These are not pre-trade sizing features, but they are still part of the risk-management subsystem.

### 13.10 Persistence model

Your spec says settings should persist, but true risk protection should not rely only on browser state.

So the model should be:

- `localStorage` for fast UX restore
- database-backed user terminal settings for durable persistence
- server/runtime enforcement for the hard limits

Important rule:

> browser persistence is convenience; server-side enforcement is protection.

### 13.11 Current live system vs target

Today the live system has only part of this model:

- lot size engine exists
- R:R validation exists
- max daily/open trade logic exists in the AI scheduler path
- setup invalidation / `loss_edge` exists
- terminal UI controls now exist in first-pass form on [frontend/src/app/terminal/TerminalWorkspace.tsx](frontend/src/app/terminal/TerminalWorkspace.tsx)

But these are still missing end-to-end:

- daily loss limit enforcement
- daily profit target lockout
- max drawdown enforcement
- session/news enforcement in the execution path
- persisted right-sidebar risk settings
- runtime-enforced AI dynamic SL model
- final end-to-end coupling between structure sensitivity and execution-time stop behavior

### 13.12 Recommended product interpretation

The cleanest interpretation of your spec is:

- `Risk %` or `Risk $` decides **how much money can be lost**
- `SL mode` decides **where the stop goes**
- `AI_SENSITIVITY` or `Structure Sensitivity` decides **how structure is detected**
- optional `AI Stop Model` decides **how aggressively the stop is buffered**
- lot size is recalculated from those choices so total risk stays capped

That is the safest and most professional way for the terminal to behave.

---

## 14. Priority Build Order

### Priority 1 — terminal shell
- add `/terminal`
- port top/nav/left/right/chart layout

### Priority 2 — right sidebar persistence
- risk settings storage
- terms acceptance
- UI state persistence

### Priority 3 — positions workstation
- real open positions
- account metrics
- close-position actions

### Priority 4 — sessions/news enforcement
- save settings
- enforce before job execution

### Priority 5 — copy trading
- leaderboard + follow state
- later real execution mirroring

---

## 15. Final Audit Verdict

### What is already strong
- runtime/backend foundation
- MT5 queue/execution model
- setup/state/structure engine
- real chart + price feed
- Supabase integration

### What is missing most
- the actual **manual-terminal UX layer**
- the **right risk sidebar**
- **positions terminal**
- **terms/news/sessions workflow**
- **copy trading integration**

### Final conclusion

You are **much closer than it looks**.

The system already has the hard parts:
- execution
- state machine
- structure engine
- live feed
- charting
- DB/runtime plumbing

What is missing is primarily the **product UI assembly** and the **feature wiring between the prototype terminal and the live backend**.

So the next build step should be:

> **Port the prototype terminal into `frontend/` as a real `/terminal` route and wire it to the existing live services.**

That is the fastest path to the product you described.

### Status update

This step has now begun:
- `/terminal` route added
- live chart/feed wired there
- live `trade_jobs` queue wired there
- live setup monitor + state-machine feedback wired there
- runtime heartbeat/account snapshot wired there

### Still missing after the first `/terminal` pass

- server-backed right-sidebar risk settings persistence
- runtime-enforced AI dynamic stop model
- full `AI_SENSITIVITY` -> SL/risk integration in the execution path
- server-backed formal terms acceptance audit trail
- session/news enforcement in execution path
- live open-position workstation
- copy trading execution backend
- richer trader polish from the full prototype component set

### Additional status update

The `/terminal` route now also has:

- local persistence for right-sidebar terminal settings
- server-backed terminal settings read/write path added in code
- migration file added at [docs/terminal_settings_migration.sql](docs/terminal_settings_migration.sql)
- local persistence for the current terms version gate
- server-side pre-queue enforcement path for:
	- terms acceptance
	- max trades/day
	- no-session-enabled guard
- basic local execution blocking for:
	- missing terms acceptance
	- zero/invalid risk budget
	- max trades/day reached from the visible execution stream

The `/terminal` route now also supports three stop models in the live UI shell:

- `Setup`
- `Manual`
- `AI Dynamic`

`AI Dynamic` is now defined in product terms as:

$$
AI\_SENSITIVITY \rightarrow pivot\_window \rightarrow confirmed\ swing\ structure \rightarrow dynamic\ SL
$$

So the stop moves with broader or narrower structure, while lot size still recalculates to hold the risk budget constant.

This improves the product immediately. The remaining gap is full runtime/news/session enforcement end-to-end after the migration is applied and the remaining policy hooks are wired.

