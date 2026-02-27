"""
base_strategy.py
IFX AI Engine — Base strategy interface.

All strategies MUST inherit from BaseStrategy and implement generate().
This contract ensures strategies are swappable without touching
any other module.

To add a new strategy:
  1. Create a new file in ai_engine/strategies/
  2. Inherit from BaseStrategy
  3. Implement generate()
  4. Register in decision_runner.py

Strategies must NOT:
  - Calculate lot size (that is risk_engine's job)
  - Create trade_jobs (that is job_queue's job)
  - Access MT5 directly
  - Access Supabase directly
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MarketContext:
    """
    Everything a strategy needs to make a decision.
    Assembled by eval_scheduler before calling strategy.generate().
    """
    symbol: str
    timeframe: str
    current_price: float
    spread_pips: float
    pip_value_per_lot: float
    ohlcv: list[dict]          # [{time, open, high, low, close, tick_volume}, ...]

    # User config
    rr_min: float
    rr_max: float
    filters_json: dict = field(default_factory=dict)


@dataclass
class TradeIdea:
    """
    Output of a strategy's generate() method.

    This is NOT a trade yet — it becomes one only after:
      risk_engine validates lot size
      job_queue validates limits
      insert_ai_decision_and_job RPC runs

    Fields:
      direction:        'buy' or 'sell'
      entry_price:      price to enter
      sl:               absolute stop loss price level
      tp:               absolute take profit price level
      sl_distance_pips: SL distance (used by risk_engine for lot size calc)
      confidence:       0.0 – 1.0 (optional, for logging/filtering)
      reasoning:        dict stored in ai_trade_decisions.reasoning (audit log)
    """
    symbol: str
    direction: str              # 'buy' | 'sell'
    entry_price: float
    sl: float
    tp: float
    sl_distance_pips: float

    confidence: float = 1.0
    reasoning: dict = field(default_factory=dict)


class BaseStrategy(ABC):
    """
    Abstract base for all IFX trading strategies.

    Subclasses implement generate() and return a TradeIdea or None.
    Returning None means "no setup right now" — not an error.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable strategy name, e.g. 'EMA_Crossover'"""
        ...

    @abstractmethod
    def generate(self, ctx: MarketContext) -> Optional[TradeIdea]:
        """
        Analyse market context and return a trade idea if a setup exists.

        Args:
            ctx: MarketContext with OHLCV data + user config

        Returns:
            TradeIdea if setup found, None if no trade.

        Must:
          - Be deterministic for the same input
          - Complete in < 10s
          - Never raise (catch all exceptions internally, return None)
          - Never call MT5, Supabase, or risk_engine
        """
        ...
