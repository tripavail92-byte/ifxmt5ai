# EA Execution Validation Migration

The terminal bootstrap system can be built now, but the current trade-execution safety checks still live in [runtime/job_worker.py](runtime/job_worker.py).

These checks must be ported into the EA-side execution layer before the Python worker stops being the primary execution engine.

## Validations To Move

### Symbol readiness

Port the logic behind:

- symbol selection retries
- broker symbol resolution
- tradable symbol fallback handling

Current reference area:

- [runtime/job_worker.py](runtime/job_worker.py)

### Idempotency markers

Port the logic behind:

- `build_job_comment_marker`
- `find_existing_order_by_job_id`

EA-side equivalent:

- deterministic comment marker per signal or execution id
- check open positions, orders, and recent history before re-sending

### Stop and target normalization

Port the logic behind:

- `_normalize_market_stops`
- price rounding to tick size
- min stop distance and freeze distance handling

This is one of the most important pieces for successful broker execution.

### Filling mode fallback

Port the logic that retries order send across supported filling modes when the preferred mode fails.

Without this, the EA will reject valid trades on brokers with different fill policies.

### Broker retcode handling

Port the current worker behavior that records:

- retcode
- request id
- broker message
- failure category

The EA must return these values back through `trade-audit` and `events`.

### Session and risk blockers

Port the equivalent of:

- session guardrails
- daily trade limit checks
- max position size checks
- drawdown and profit lockouts

Current reference area:

- [runtime/db_client.py](runtime/db_client.py)

### Position close path

Port the logic behind:

- `close_position_by_ticket`
- opposite-side close execution
- close retcode handling

### Trade lifecycle management

After entry succeeds, the EA must own:

- break-even
- trailing stop
- partial close
- invalidation close

## Migration Order

1. Terminal bootstrap and EA launch
2. EA registration and config sync
3. EA-side market order validation and send path
4. EA-side pending order validation and send path
5. EA-side close management
6. Worker becomes fallback only

## Current Status

This migration document exists because terminal bootstrap can be implemented immediately, while the full execution validation port requires dedicated EA work.

Do not remove the Python worker from production execution until the items above are implemented inside the EA and validated with live broker responses.
