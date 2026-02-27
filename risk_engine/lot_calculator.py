"""
risk_engine.py
IFX AI Trading Portal — Lot size + risk validation engine.

This module is the ONLY place lot size is calculated.
Every calculation is deterministic and per-user.
Never import this inside job_worker.py — workers do not do risk calculations.

Usage:
  from risk_engine import calculate_lot_size, validate_risk_constraints
"""

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data contracts
# ---------------------------------------------------------------------------

@dataclass
class RiskProfile:
    """User strategy risk settings (from user_strategies row)."""
    risk_percent: float       # e.g. 1.5 = 1.5% of balance per trade
    max_daily_trades: int
    max_open_trades: int
    rr_min: float
    rr_max: float


@dataclass
class LotSizeResult:
    lot_size: float           # calculated lot size (rounded to broker step)
    risk_amount: float        # currency amount at risk
    pip_risk: float           # sl distance in pips
    balance_used: float       # balance snapshot used for calculation
    valid: bool
    reason: Optional[str] = None


@dataclass
class RiskValidationResult:
    valid: bool
    rejection_reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Lot size calculation
# ---------------------------------------------------------------------------

# Standard pip values per lot for common pairs (used when tick_value unavailable)
# For production you should calculate from symbol_info tick_value dynamically.
_PIP_FALLBACK_VALUE_PER_LOT = {
    "XAUUSD": 10.0,    # Gold: $10 per pip per lot
    "default": 10.0,   # Most major FX pairs on USD accounts
}


def calculate_lot_size(
    symbol: str,
    balance: float,
    risk_percent: float,
    sl_distance_pips: float,
    pip_value_per_lot: Optional[float] = None,
    lot_step: float = 0.01,
    min_lot: float = 0.01,
    max_lot: float = 100.0,
) -> LotSizeResult:
    """
    Calculate the correct lot size for a trade based on user risk settings.

    Formula:
        risk_amount  = balance × (risk_percent / 100)
        lot_size_raw = risk_amount / (sl_distance_pips × pip_value_per_lot)
        lot_size     = round to nearest lot_step, clamp to [min_lot, max_lot]

    Args:
        symbol:              Trading symbol (e.g. 'EURUSD', 'XAUUSD')
        balance:             Account balance in account currency
        risk_percent:        Risk per trade as a percentage of balance
        sl_distance_pips:    Stop loss distance in pips from entry
        pip_value_per_lot:   Monetary value of 1 pip for 1 standard lot.
                             If None, uses fallback table.
        lot_step:            Minimum lot increment (from symbol_info)
        min_lot:             Minimum allowed lot size (from symbol_info)
        max_lot:             Maximum allowed lot size (from symbol_info)

    Returns:
        LotSizeResult with the calculated lot size and metadata.
    """
    if balance <= 0:
        return LotSizeResult(0, 0, sl_distance_pips, balance, False, "Balance must be > 0")
    if risk_percent <= 0 or risk_percent > 100:
        return LotSizeResult(0, 0, sl_distance_pips, balance, False, "risk_percent must be 0–100")
    if sl_distance_pips <= 0:
        return LotSizeResult(0, 0, sl_distance_pips, balance, False, "sl_distance_pips must be > 0")

    # Pip value fallback
    if pip_value_per_lot is None:
        symbol_upper = symbol.upper()
        pip_value_per_lot = _PIP_FALLBACK_VALUE_PER_LOT.get(
            symbol_upper,
            _PIP_FALLBACK_VALUE_PER_LOT["default"],
        )
        logger.debug(
            "Using fallback pip value %.2f for %s",
            pip_value_per_lot, symbol,
        )

    risk_amount = balance * (risk_percent / 100.0)
    lot_size_raw = risk_amount / (sl_distance_pips * pip_value_per_lot)

    # Round to broker's lot_step
    lot_size = round(round(lot_size_raw / lot_step) * lot_step, 8)

    # Clamp
    lot_size = max(min_lot, min(lot_size, max_lot))

    if lot_size <= 0:
        return LotSizeResult(
            0, risk_amount, sl_distance_pips, balance, False,
            f"Calculated lot_size={lot_size_raw:.5f} rounds to 0 (balance too small or SL too wide)"
        )

    logger.info(
        "Lot size calc: symbol=%s balance=%.2f risk=%.1f%% sl_pips=%.1f "
        "pip_val=%.2f → raw=%.5f → lot=%.2f (risk_amount=%.2f)",
        symbol, balance, risk_percent, sl_distance_pips,
        pip_value_per_lot, lot_size_raw, lot_size, risk_amount,
    )

    return LotSizeResult(
        lot_size=lot_size,
        risk_amount=risk_amount,
        pip_risk=sl_distance_pips,
        balance_used=balance,
        valid=True,
    )


# ---------------------------------------------------------------------------
# Risk:Reward validation
# ---------------------------------------------------------------------------

def calculate_rr(
    entry: float,
    sl: float,
    tp: float,
    direction: str,
) -> float:
    """
    Calculate the actual risk:reward ratio for a trade.

    Returns RR as a positive float (e.g. 2.0 = 1:2 RR).
    Returns 0.0 if SL/TP are invalid.
    """
    if direction == "buy":
        risk = entry - sl
        reward = tp - entry
    else:
        risk = sl - entry
        reward = entry - tp

    if risk <= 0 or reward <= 0:
        return 0.0

    return round(reward / risk, 4)


# ---------------------------------------------------------------------------
# Pre-trade risk constraint validation
# ---------------------------------------------------------------------------

def validate_risk_constraints(
    profile: RiskProfile,
    rr_actual: float,
    daily_trade_count: int,
    open_trade_count: int,
) -> RiskValidationResult:
    """
    Enforce all per-user risk rules before creating a trade_job.

    Args:
        profile:           RiskProfile from user_strategies row
        rr_actual:         The actual RR of this trade setup
        daily_trade_count: Number of trades already taken today (from DB)
        open_trade_count:  Number of currently open/pending trades (from DB)

    Returns:
        RiskValidationResult — valid=True if trade can proceed
    """
    if daily_trade_count >= profile.max_daily_trades:
        return RiskValidationResult(
            False,
            f"Daily trade limit reached: {daily_trade_count}/{profile.max_daily_trades}",
        )

    if open_trade_count >= profile.max_open_trades:
        return RiskValidationResult(
            False,
            f"Open trade limit reached: {open_trade_count}/{profile.max_open_trades}",
        )

    if rr_actual < profile.rr_min:
        return RiskValidationResult(
            False,
            f"RR too low: {rr_actual:.2f} < min {profile.rr_min}",
        )

    if rr_actual > profile.rr_max:
        return RiskValidationResult(
            False,
            f"RR too high: {rr_actual:.2f} > max {profile.rr_max}",
        )

    return RiskValidationResult(True)
