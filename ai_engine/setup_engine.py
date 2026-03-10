"""
ai_engine.setup_engine
======================
Pure state machine for trading setup lifecycle.

No I/O.  No threading.  No database.  No side effects.
Every function is deterministic for the same inputs.

States
------
IDLE       — price away from zone, setup is armed but inactive
STALKING   — price has entered the entry zone band (alert, no signal yet)
PURGATORY  — a tick wick broke the loss edge; awaiting H1 candle close to confirm
DEAD       — H1 candle CLOSED beyond the loss edge; setup is invalidated

Transition rules
----------------
Tick rules  (evaluated on every price tick):
  T1  DEAD  → any state      BLOCKED — ticks cannot change DEAD
  T2  any   → PURGATORY      price wick breaks loss_edge mid-bar
  T3  any   → STALKING       price ticks inside [zone_low, zone_high]
  T4  any   → IDLE           price is outside zone and on safe side of loss_edge

H1 candle-close rules  (evaluated only on the H1 bar close):
  C1  PURGATORY → DEAD       H1 close is on the wrong side of loss_edge
  C1  PURGATORY → STALKING   H1 close is safe AND inside zone
  C1  PURGATORY → IDLE       H1 close is safe AND outside zone
  C2  DEAD      → STALKING   resurrection: next H1 closes safe AND inside zone
  C2  DEAD      → IDLE       resurrection: next H1 closes safe AND outside zone
  C2  DEAD      → DEAD       next H1 still unsafe — remains dead

No in-zone signal is fired here.  That is the setup_manager's responsibility.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# Type alias
# ---------------------------------------------------------------------------

SetupState = str  # literal: 'IDLE' | 'STALKING' | 'PURGATORY' | 'DEAD'

IDLE      : SetupState = "IDLE"
STALKING  : SetupState = "STALKING"
PURGATORY : SetupState = "PURGATORY"
DEAD      : SetupState = "DEAD"

ALL_STATES = frozenset({IDLE, STALKING, PURGATORY, DEAD})


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Setup:
    """
    Immutable description of a trading setup + current mutable state.

    Callers must replace `state` (and optionally `dead_trigger_candle_time`)
    based on what evaluate_tick() / evaluate_candle() return.
    The dataclass itself is NOT frozen so state can be updated in-place.
    """
    id:               str
    connection_id:    str
    symbol:           str
    side:             str            # 'buy' | 'sell'

    # Chart timeframe used for structure / CHOCH-BOS detection (e.g., '5m', '1h')
    timeframe:        str

    # AI sensitivity (NI) used for structure analysis.
    # Direct correlation: pivot_window = ai_sensitivity (1–10)
    ai_sensitivity:   int = 5

    entry_price:      float
    zone_low:         float          # entry * (1 - zone_percent/100)
    zone_high:        float          # entry * (1 + zone_percent/100)

    # Derived from side:
    #   BUY  → loss_edge = zone_low,  target = zone_high
    #   SELL → loss_edge = zone_high, target = zone_low
    loss_edge:        float
    target:           float

    state:            SetupState     # current state
    dead_trigger_candle_time: Optional[int] = None  # epoch_s of H1 that caused DEAD

    # Trade Now: when True, setup_manager fires a 0.01-lot market order
    # the moment STALKING + matching structure break is detected (one-shot).
    trade_now_active: bool = False

    # Optional metadata (not used by engine logic)
    user_id:          Optional[str]  = None
    notes:            Optional[str]  = None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _beyond_loss(setup: Setup, price: float) -> bool:
    """True if price has crossed the loss edge to the wrong side."""
    if setup.side == "buy":
        return price < setup.loss_edge
    return price > setup.loss_edge


def _safe_side(setup: Setup, price: float) -> bool:
    """True if price is on the safe side of the loss edge."""
    return not _beyond_loss(setup, price)


def _in_zone(setup: Setup, price: float) -> bool:
    """True if price is within [zone_low, zone_high] (inclusive)."""
    return setup.zone_low <= price <= setup.zone_high


# ---------------------------------------------------------------------------
# Core: tick evaluation
# ---------------------------------------------------------------------------

def evaluate_tick(setup: Setup, price: float) -> SetupState:
    """
    Return the new state based on a price tick.

    Rule T1: if DEAD, tick logic is completely blocked.
    Rule T2: intrabar wick breaks loss_edge → PURGATORY
    Rule T3: price inside zone → STALKING
    Rule T4: price outside zone but safe → IDLE
    """
    # T1 — DEAD blocks all tick transitions
    if setup.state == DEAD:
        return DEAD

    # T2 — wick breaks loss edge → wait for H1 close
    if _beyond_loss(setup, price):
        return PURGATORY

    # T3 — price entered the zone band
    if _in_zone(setup, price):
        return STALKING

    # T4 — safe, outside zone → default resting state
    return IDLE


# ---------------------------------------------------------------------------
# Core: H1 candle-close evaluation
# ---------------------------------------------------------------------------

def evaluate_candle(
    setup: Setup,
    h1_close: float,
    h1_candle_time: int,
) -> SetupState:
    """
    Return the new state based on an H1 candle close.

    Args:
        setup:            current Setup (state is read but not mutated here)
        h1_close:         the closing price of the completed H1 bar
        h1_candle_time:   open-time (epoch_s) of the H1 bar that just closed

    Rules:
        PURGATORY → C1: H1 close beyond loss_edge  → DEAD
                        H1 close safe + in zone     → STALKING
                        H1 close safe + out of zone → IDLE
        DEAD      → C2: only applies to the candle AFTER the death candle
                        safe + in zone              → STALKING (resurrection)
                        safe + out of zone          → IDLE     (resurrection)
                        still unsafe                → DEAD     (stays dead)
        IDLE/STALKING → no H1 transition (candle does not change these states)
    """
    if setup.state == PURGATORY:
        # C1: H1 close confirms or denies the intrabar breach
        if _beyond_loss(setup, h1_close):
            return DEAD                          # confirmed invalidation

        # Safe close — resolve back from purgatory
        return STALKING if _in_zone(setup, h1_close) else IDLE

    if setup.state == DEAD:
        # C2: resurrection — only the candle AFTER the death candle can resurrect
        if setup.dead_trigger_candle_time is None:
            return DEAD
        if h1_candle_time <= setup.dead_trigger_candle_time:
            return DEAD                          # same candle or older — stay dead

        if _safe_side(setup, h1_close):
            return STALKING if _in_zone(setup, h1_close) else IDLE

        return DEAD                              # still on wrong side

    # IDLE / STALKING — H1 candle close has no direct effect
    return setup.state


# ---------------------------------------------------------------------------
# Helpers for callers
# ---------------------------------------------------------------------------

def build_setup_from_row(row: dict) -> Setup:
    """
    Construct a Setup dataclass from a Supabase `trading_setups` row dict.
    """
    return Setup(
        id                       = row["id"],
        connection_id            = row["connection_id"],
        user_id                  = row.get("user_id"),
        symbol                   = row["symbol"],
        side                     = row["side"],
        timeframe                = (row.get("timeframe") or "5m"),
        ai_sensitivity            = int(row.get("ai_sensitivity") or 5),
        entry_price              = float(row["entry_price"]),
        zone_low                 = float(row["zone_low"]),
        zone_high                = float(row["zone_high"]),
        loss_edge                = float(row["loss_edge"]),
        target                   = float(row["target"]),
        state                    = row.get("state", IDLE),
        dead_trigger_candle_time = row.get("dead_trigger_candle_time"),
        trade_now_active         = bool(row.get("trade_now_active", False)),
        notes                    = row.get("notes"),
    )
