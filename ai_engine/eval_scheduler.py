"""
eval_scheduler.py
IFX AI Trading Portal — AI Evaluation Scheduler.

Runs every AI_EVAL_INTERVAL_MIN minutes.
For each active user strategy:
  1. Fetch strategy + account state from Supabase
  2. Fetch market data (OHLCV) via MT5 or market data provider
  3. Call ai_engine.generate_decision()
  4. Run risk_engine validation (lot size, RR, daily limits)
  5. Persist ai_trade_decision + trade_job via Supabase RPC

This is a BACKEND process — runs on the VPS alongside the workers.
It creates jobs. It does NOT execute trades.

Usage:
  python eval_scheduler.py

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  MT5_CREDENTIALS_MASTER_KEY_B64
"""

import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

import MetaTrader5 as mt5

import db_client as db
from ai_engine import (
    StrategyContext,
    generate_decision,
    get_pip_size,
    price_to_pips,
)
from risk_engine import (
    LotSizeResult,
    RiskProfile,
    calculate_lot_size,
    calculate_rr,
    validate_risk_constraints,
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "eval_scheduler.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("eval_scheduler")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

cfg_path = Path(__file__).parent / "config" / "settings.json"
with open(cfg_path) as f:
    CFG = json.load(f)

EVAL_INTERVAL_SEC = CFG["AI_EVAL_INTERVAL_MIN"] * 60


# ---------------------------------------------------------------------------
# Market data helpers (MT5-based)
# NOTE: If you use a separate market data provider, replace these.
# ---------------------------------------------------------------------------

_mt5_initialized = False


def ensure_mt5_market_data_session() -> bool:
    """
    Initialize a shared MT5 session for market data only.
    Uses the first available online worker terminal as read-only data source.

    Returns True if ready, False otherwise.
    """
    global _mt5_initialized
    if _mt5_initialized:
        info = mt5.terminal_info()
        if info and info.connected:
            return True
        _mt5_initialized = False

    test_terminal = os.environ.get(
        "MT5_TEST_TERMINAL_DIR",
        r"C:\mt5system\mt5-test-terminal",
    )
    result = mt5.initialize(path=str(Path(test_terminal) / "terminal64.exe"), portable=True)
    if result:
        _mt5_initialized = True
        logger.info("MT5 market data session initialized.")
    else:
        logger.warning("MT5 market data session failed: %s", mt5.last_error())
    return result


def get_ohlcv(symbol: str, timeframe_str: str, count: int = 200) -> list[dict]:
    """
    Fetch OHLCV candles from MT5 for the given symbol and timeframe.

    Returns list of dicts: {time, open, high, low, close, tick_volume}
    """
    tf_map = {
        "M1": mt5.TIMEFRAME_M1,   "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,   "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,   "W1": mt5.TIMEFRAME_W1,
    }
    tf = tf_map.get(timeframe_str.upper(), mt5.TIMEFRAME_H1)
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None or len(rates) == 0:
        return []
    return [
        {
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
        }
        for r in rates
    ]


def get_current_price_and_spread(symbol: str) -> tuple[float, float]:
    """Return (mid_price, spread_in_pips) for a symbol."""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return 0.0, 0.0
    mid = (tick.ask + tick.bid) / 2.0
    spread_pips = price_to_pips(symbol, tick.ask - tick.bid)
    return round(mid, 6), round(spread_pips, 2)


def get_pip_value_per_lot(symbol: str) -> float:
    """
    Get the monetary pip value per standard lot (1.0) in account currency.
    Falls back to 10.0 if symbol_info is unavailable.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return 10.0

    # trade_tick_value is the value of 1 tick for 1 lot
    # trade_tick_size is the size of 1 tick in price units
    # pip = get_pip_size(symbol); pips_per_tick = pip / tick_size
    tick_size = info.trade_tick_size
    tick_value = info.trade_tick_value

    pip_size = get_pip_size(symbol)
    if tick_size <= 0:
        return 10.0

    return round(tick_value * (pip_size / tick_size), 4)


# ---------------------------------------------------------------------------
# Per-strategy evaluation
# ---------------------------------------------------------------------------

def evaluate_strategy(strategy: dict) -> None:
    """
    Run one full evaluation cycle for a single user strategy.
    Writes ai_trade_decision (and optionally trade_job) to Supabase.
    """
    conn_id = strategy["connection_id"]
    strat_id = strategy["strategy_id"]
    user_id = strategy["user_id"]
    symbol = strategy["allowed_symbols"][0] if strategy["allowed_symbols"] else None

    if not symbol:
        logger.warning("[%s] No allowed symbols in strategy — skipping.", conn_id[:8])
        return

    # Get balance from last heartbeat metrics
    metrics = strategy.get("last_metrics") or {}
    balance = float(metrics.get("balance", 0.0))

    if balance <= 0:
        logger.warning(
            "[%s] Balance is 0 or unavailable in heartbeat metrics — skipping.",
            conn_id[:8],
        )
        return

    # Ensure MT5 market data session
    if not ensure_mt5_market_data_session():
        logger.error("Cannot get market data — MT5 session unavailable.")
        return

    # Make symbol visible
    mt5.symbol_select(symbol, True)

    # Fetch market data
    ohlcv = get_ohlcv(symbol, strategy["timeframe"])
    current_price, spread_pips = get_current_price_and_spread(symbol)
    pip_value = get_pip_value_per_lot(symbol)

    # Build context for AI engine
    ctx = StrategyContext(
        strategy_id=strat_id,
        user_id=user_id,
        connection_id=conn_id,
        symbol=symbol,
        timeframe=strategy["timeframe"],
        allowed_symbols=strategy["allowed_symbols"],
        risk_percent=float(strategy["risk_percent"]),
        rr_min=float(strategy["rr_min"]),
        rr_max=float(strategy["rr_max"]),
        filters_json=strategy.get("filters_json") or {},
        account_balance=balance,
        account_login=strategy.get("account_login", ""),
        ohlcv=ohlcv,
        current_price=current_price,
        spread_pips=spread_pips,
        pip_value_per_lot=pip_value,
    )

    # Run AI engine
    decision = generate_decision(ctx)

    if decision is None:
        logger.info("[%s] No trade signal for %s %s.", conn_id[:8], symbol, strategy["timeframe"])
        db.get_client().rpc("mark_strategy_evaluated", {"p_strategy_id": strat_id}).execute()
        return

    # Calculate lot size
    lot_result: LotSizeResult = calculate_lot_size(
        symbol=symbol,
        balance=balance,
        risk_percent=float(strategy["risk_percent"]),
        sl_distance_pips=decision.sl_distance_pips,
        pip_value_per_lot=decision.pip_value_per_lot,
    )

    if not lot_result.valid:
        logger.warning("[%s] Lot size invalid: %s", conn_id[:8], lot_result.reason)
        _persist_decision(
            user_id, conn_id, strat_id, decision, lot_result.lot_size,
            rr_actual=0.0, pip_risk=decision.sl_distance_pips,
            balance=balance, decision_str="rejected",
            rejection_reason=f"Lot size error: {lot_result.reason}",
        )
        return

    # Calculate RR
    rr_actual = calculate_rr(
        decision.entry_price, decision.sl, decision.tp, decision.direction
    )

    # Fetch daily + open trade counts
    daily_count = db.get_client().rpc(
        "count_daily_trades", {"p_connection_id": conn_id}
    ).execute().data or 0

    open_count = db.get_client().rpc(
        "count_open_trades", {"p_connection_id": conn_id}
    ).execute().data or 0

    profile = RiskProfile(
        risk_percent=float(strategy["risk_percent"]),
        max_daily_trades=strategy["max_daily_trades"],
        max_open_trades=strategy["max_open_trades"],
        rr_min=float(strategy["rr_min"]),
        rr_max=float(strategy["rr_max"]),
    )

    validation = validate_risk_constraints(profile, rr_actual, daily_count, open_count)

    decision_str = "accepted" if validation.valid else "rejected"
    rejection_reason = validation.rejection_reason

    logger.info(
        "[%s] Decision: symbol=%s dir=%s vol=%.2f rr=%.2f → %s %s",
        conn_id[:8], symbol, decision.direction, lot_result.lot_size,
        rr_actual, decision_str, f"({rejection_reason})" if rejection_reason else "",
    )

    _persist_decision(
        user_id, conn_id, strat_id, decision,
        volume=lot_result.lot_size,
        rr_actual=rr_actual,
        pip_risk=decision.sl_distance_pips,
        balance=balance,
        decision_str=decision_str,
        rejection_reason=rejection_reason,
    )

    db.get_client().rpc("mark_strategy_evaluated", {"p_strategy_id": strat_id}).execute()


def _persist_decision(
    user_id, conn_id, strat_id, decision,
    volume, rr_actual, pip_risk, balance,
    decision_str, rejection_reason=None,
) -> None:
    """Write ai_trade_decision (and optionally trade_job) to Supabase."""
    try:
        db.get_client().rpc(
            "insert_ai_decision_and_job",
            {
                "p_user_id": user_id,
                "p_connection_id": conn_id,
                "p_strategy_id": strat_id,
                "p_symbol": decision.symbol,
                "p_direction": decision.direction,
                "p_entry_price": decision.entry_price,
                "p_sl": decision.sl,
                "p_tp": decision.tp,
                "p_volume": volume,
                "p_rr_actual": rr_actual,
                "p_pip_risk": pip_risk,
                "p_balance_snapshot": balance,
                "p_reasoning": decision.reasoning,
                "p_decision": decision_str,
                "p_rejection_reason": rejection_reason,
            },
        ).execute()
    except Exception as exc:
        logger.error("[%s] Failed to persist decision: %s", conn_id[:8], exc)
        db.log_event("error", "worker", f"Failed to persist AI decision: {exc}", conn_id)


# ---------------------------------------------------------------------------
# Main evaluation loop
# ---------------------------------------------------------------------------

def run_eval_loop() -> None:
    logger.info("=== IFX Eval Scheduler starting (interval=%ds) ===", EVAL_INTERVAL_SEC)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    while True:
        logger.info("--- Evaluation cycle starting ---")
        try:
            strategies = db.get_client().rpc(
                "get_active_strategies_for_eval", {}
            ).execute().data or []

            logger.info("Found %d active strategy/connection(s) to evaluate.", len(strategies))

            for strategy in strategies:
                try:
                    evaluate_strategy(strategy)
                except Exception as exc:
                    logger.error(
                        "Error evaluating strategy %s: %s",
                        strategy.get("strategy_id", "?"), exc, exc_info=True,
                    )
                    db.log_event(
                        "error", "worker",
                        f"Eval error: {exc}",
                        strategy.get("connection_id"),
                    )

        except Exception as exc:
            logger.error("Eval loop error: %s", exc, exc_info=True)

        logger.info("--- Evaluation cycle complete. Sleeping %ds ---", EVAL_INTERVAL_SEC)
        time.sleep(EVAL_INTERVAL_SEC)


if __name__ == "__main__":
    run_eval_loop()
