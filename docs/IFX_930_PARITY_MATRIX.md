# IFX v9.30 Parity Matrix

## Canonical Source

- Trading source of truth: `finaleabyahsan.txt`
- Runtime target: `MQL5/Experts/IFX_6Gate_Cloud_v1.mq5`
- Requirement: exact behavioral parity with v9.30, not an approximation

## Acceptance Rule

The cloud EA, control plane, and UI are only considered complete when they reproduce the same:

- setup parsing
- entry gating
- stop placement
- lot sizing
- partial/BE/trailing behavior
- EOD behavior
- reporting behavior
- live-state semantics

for the same symbol, same candles, and same config inputs.

## Workstreams

### 1. EA Core Port

- Port `OnTick()` entry gate from v9.30 exactly.
- Port dynamic pre-entry stop engine exactly.
- Port `ManageOpenPositions()` exactly.
- Port strict-risk semantics exactly.
- Port daily-report and Discord semantics exactly.

### 2. Config Contract

- Publish every v9.30 field through `ea_user_configs`.
- Carry raw AI text as a first-class field.
- Remove silent fallback defaults that change live behavior.

### 3. UI De-Braining

- Remove browser-side trade-authority logic.
- Treat UI as config editor, command sender, and EA-state monitor.
- Make EA-reported state the only live truth shown to operators.

### 4. Observability

- Show command requested / acknowledged / executed / rejected states.
- Use EA runtime events and trade audit as primary execution truth.
- Retire `trade_jobs` as the user-facing primary execution story.

## Current Highest-Priority Gaps

1. Cloud EA enters on zone touch without the original structure-break trigger.
2. Cloud EA stop-loss construction differs from the v9.30 dynamic fallback stop engine.
3. Strict-risk semantics differ from v9.30.
4. Browser UI still computes authoritative stop/risk/blocker logic locally.
5. Published EA config does not yet cover the full v9.30 model.

## Verification Matrix

### Config

- Every v9.30 input has a cloud representation.
- Published config matches what the EA actually applies.

### Entry

- Same pivot/TP/bias/session state produces the same entry/no-entry outcome.
- Same candles produce the same BOS/SMS trigger outcome.

### Risk

- Same account metrics and symbol spec produce the same lot size.
- Strict-risk abort matches v9.30.

### Management

- TP1 recognition matches v9.30.
- Break-even trigger matches v9.30.
- Trailing stop modification matches v9.30.
- EOD close behavior matches v9.30.

### UI

- Displayed setup state comes from EA truth, not browser inference.
- Displayed execution outcome comes from EA ack/runtime/audit truth.