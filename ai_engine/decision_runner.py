"""
ai_engine.py
IFX AI Trading Portal — AI Decision Engine Interface.

This module defines the interface between the eval scheduler and
the actual strategy logic. The strategy logic that processes market
data and generates signals plugs in here.

Architecture:
  eval_scheduler.py → ai_engine.generate_decision() → risk_engine.py → DB

IMPORTANT:
  - This module does NOT touch MT5 directly.
  - It does NOT place trades.
  - It outputs a TradeDecision object which the scheduler validates + persists.
  - Strategy implementations live in strategies/ subdirectory.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------

@dataclass
class TradeDecision:
    """
    Output of the AI engine for one user/connection/strategy.
    This is what gets written to ai_trade_decisions and
    (if accepted) to trade_jobs.
    """
    symbol: str
    direction: str              # 'buy' | 'sell'
    entry_price: float
    sl: float
    tp: float

    sl_distance_pips: float     # used by risk_engine to calculate lot size
    pip_value_per_lot: float    # broker-specific, passed in from market data

    reasoning: dict = field(default_factory=dict)   # metadata for audit log

    # Set by scheduler after risk_engine runs
    volume: float = 0.0
    rr_actual: float = 0.0


@dataclass
class StrategyContext:
    """
    All inputs the AI engine needs to make a decision for one user.
    Assembled by eval_scheduler from Supabase + market data.
    """
    strategy_id: str
    user_id: str
    connection_id: str

    symbol: str
    timeframe: str
    allowed_symbols: list[str]

    risk_percent: float
    rr_min: float
    rr_max: float
    filters_json: dict

    account_balance: float      # from last_metrics heartbeat
    account_login: str

    # Market data (populated by scheduler before calling engine)
    ohlcv: list[dict] = field(default_factory=list)   # [{time, open, high, low, close, tick_volume}]
    current_price: float = 0.0
    spread_pips: float = 0.0
    pip_value_per_lot: float = 10.0


# ---------------------------------------------------------------------------
# Engine interface
# ---------------------------------------------------------------------------

def generate_decision(ctx: StrategyContext) -> Optional[TradeDecision]:
    """
    Run the AI strategy for one user and return a trade decision.

    Returns:
        TradeDecision if a valid setup is found.
        None if no trade setup exists right now (no trade = correct result).

    This function must:
      - Be deterministic for the same inputs
      - Never raise exceptions — catch internally and return None
      - Never call mt5 directly
      - Complete within reasonable time (< 30s per user)
    """
    try:
        # Guard: symbol must be in user's allowed list
        if ctx.symbol not in ctx.allowed_symbols:
            logger.debug(
                "[%s] Symbol %s not in allowed list %s",
                ctx.connection_id[:8], ctx.symbol, ctx.allowed_symbols,
            )
            return None

        # Guard: need price data
        if not ctx.ohlcv or ctx.current_price <= 0:
            logger.warning(
                "[%s] No market data for %s — skipping evaluation.",
                ctx.connection_id[:8], ctx.symbol,
            )
            return None

        # ----------------------------------------------------------------
        # Strategy logic goes here.
        #
        # This is the plug-in point for your actual strategy.
        # Replace the stub below with real signal generation.
        #
        # Example signals to implement:
        #   - EMA crossover
        #   - Supply/demand zone breaks
        #   - Session-based momentum
        #   - Fibonacci retracement levels
        #   - Price action patterns (engulfing, pin bar, etc.)
        #
        # The strategy must return:
        #   direction ('buy' or 'sell')
        #   entry_price
        #   sl (absolute price level)
        #   tp (absolute price level)
        #   reasoning dict (for audit/display)
        # ----------------------------------------------------------------

        decision = _run_strategy(ctx)
        return decision

    except Exception as exc:
        logger.error(
            "[%s] AI engine error for symbol %s: %s",
            ctx.connection_id[:8], ctx.symbol, exc, exc_info=True,
        )
        return None


# ---------------------------------------------------------------------------
# Strategy stub (replace with real logic)
# ---------------------------------------------------------------------------

def _run_strategy(ctx: StrategyContext) -> Optional[TradeDecision]:
    """
    Stub strategy implementation.

    Replace this function with real signal generation logic.
    This stub always returns None (no trade) until implemented.

    When implementing:
      1. Analyse ctx.ohlcv (list of candles for ctx.timeframe)
      2. Determine direction, entry, sl, tp
      3. Populate reasoning dict with indicator values for audit
      4. Return TradeDecision or None

    The scheduler will:
      - Call risk_engine.calculate_lot_size() using sl_distance_pips
      - Call risk_engine.calculate_rr() to verify RR is within bounds
      - Call risk_engine.validate_risk_constraints() for daily/open limits
      - Write ai_trade_decision + trade_job to DB via insert_ai_decision_and_job RPC
    """
    logger.info(
        "[%s] Strategy evaluated for %s %s — no signal (stub).",
        ctx.connection_id[:8], ctx.symbol, ctx.timeframe,
    )
    return None  # No trade — implement signal logic here


# ---------------------------------------------------------------------------
# Market data helpers (called by scheduler before generate_decision)
# ---------------------------------------------------------------------------

def get_pip_size(symbol: str) -> float:
    """
    Return the pip size for a given symbol.
    Pip size = 1 standard pip in price units.
    """
    symbol = symbol.upper()
    if "JPY" in symbol:
        return 0.01
    if symbol in ("XAUUSD", "GOLD"):
        return 0.1   # Gold: 1 pip = $0.10 per unit
    if symbol in ("XAGUSD", "SILVER"):
        return 0.001
    if symbol in ("BTCUSD", "ETHUSD"):
        return 1.0
    return 0.0001  # Standard FX pairs


def price_to_pips(symbol: str, price_distance: float) -> float:
    """Convert an absolute price distance to pips."""
    pip = get_pip_size(symbol)
    if pip <= 0:
        return 0.0
    return round(price_distance / pip, 2)
