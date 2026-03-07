"""
ai_engine.setup_manager
=======================
Manages the lifecycle of all active trading setups:

  • Loads setups from `trading_setups` Supabase table on startup
  • Refreshes the in-memory list every REFRESH_INTERVAL_S seconds
  • Receives price tick callbacks from price_relay.py and evaluates tick rules
  • Receives 1m candle-close callbacks; detects H1 boundary and evaluates H1 rules
        • While STALKING, fetches broker-native candles for setup.timeframe and detects CHOCH/BOS on closed candles
  • Writes state changes + transition audit rows to Supabase asynchronously

Integration point
-----------------
In price_relay.py, after verifying the request body:

    from ai_engine.setup_manager import setup_manager

    # in _handle_tick_batch():
    setup_manager.on_tick_batch(conn_id, ticks)

    # in _handle_candle_close():
    setup_manager.on_candle_close(conn_id, symbol, bar)

The SetupManager starts its background threads automatically when first imported
if SUPABASE_URL is present in the environment.  It is safe to import and call
even when Supabase is not configured — calls become no-ops.

H1 boundary detection
---------------------
The EA sends 1m candle-close events.  An H1 bar closes when the last 1m bar
in that hour closes.  In MetaTrader bar notation:

    bar_open_time % 3600 == 3540   →   this is the 59th-minute bar,
                                        its close IS the H1 close price.

This works for both 24-hour (crypto) and session-based (FX) instruments on
standard Exness/MetaQuotes hour-boundary bars.
"""

from __future__ import annotations

import logging
import os
import queue
import sys
import threading
import time
from typing import Optional

log = logging.getLogger("setup_manager")

# ---------------------------------------------------------------------------
# Lazy-import: add project root to path so we can import ai_engine + db_client
# from either the runtime/ working dir or directly.
# ---------------------------------------------------------------------------

def _ensure_path() -> None:
    """Add the project root (parent of ai_engine/) to sys.path once."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)


# ---------------------------------------------------------------------------
# SetupManager
# ---------------------------------------------------------------------------

REFRESH_INTERVAL_S  = 30    # re-fetch active setups from Supabase
WRITE_QUEUE_MAXSIZE = 1000  # max pending state-change writes before drops
H1_SECONDS          = 3600
H1_LAST_MINUTE_MOD  = 3540  # 59 * 60 — the 1m bar that closes the H1 period

TF_ALLOWED = {"1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"}
STRUCTURE_MIN_BARS = 50


def _pivot_window_from_ai_sensitivity(ai_sensitivity: int) -> int:
    """Direct mapping: AI_SENSITIVITY (1–10) == pivot_window (1–10)."""
    try:
        ai = int(ai_sensitivity)
    except Exception:
        ai = 5

    if ai < 1:
        ai = 1
    if ai > 10:
        ai = 10
    return ai


class SetupManager:
    """
    Singleton that holds all active Setup objects in memory and mediates
    between the price relay and the Supabase database.
    """

    def __init__(self) -> None:
        # setup_id  →  Setup
        self._setups:   dict = {}
        self._lock      = threading.Lock()
        self._write_q:  queue.Queue = queue.Queue(maxsize=WRITE_QUEUE_MAXSIZE)
        self._ready     = False
        self._db        = None
        self._started   = False

        # Structure detection dedupe
        # setup_id → last emitted event candle_time
        self._last_structure_event_time: dict[str, int] = {}
        # setup_id → last analysis-log candle_time
        self._last_structure_analysis_time: dict[str, int] = {}
        # (conn_id, symbol, tf) → last seen closed-candle time (avoid re-fetching on every 1m close)
        self._last_structure_eval_time_by_key: dict[tuple[str, str, str], int] = {}

        # H1 close dedupe (broker-native)
        # (conn_id, symbol) → last seen closed H1 candle open-time
        self._last_h1_close_time_by_key: dict[tuple[str, str], int] = {}

    # ------------------------------------------------------------------ #
    # Startup                                                              #
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """
        Start background refresh + writer threads.
        Safe to call multiple times — subsequent calls are no-ops.
        """
        if self._started:
            return
        if not os.environ.get("SUPABASE_URL"):
            log.info("[setup_manager] SUPABASE_URL not set — running in no-op mode")
            return
        self._started = True
        threading.Thread(
            target=self._refresh_loop, name="setup-refresh", daemon=True,
        ).start()
        threading.Thread(
            target=self._write_loop, name="setup-writer", daemon=True,
        ).start()
        log.info("[setup_manager] started (refresh=%ds)", REFRESH_INTERVAL_S)

    # ------------------------------------------------------------------ #
    # Public relay hooks                                                   #
    # ------------------------------------------------------------------ #

    def on_tick_batch(self, conn_id: str, ticks: list) -> None:
        """
        Called by price_relay for every /tick-batch payload.

        ticks is the raw list of tick dicts from the EA:
            [{"symbol": str, "bid": float, "ask": float, "ts_ms": int}, ...]

        We deduplicate to one evaluation per (symbol, conn_id) per batch
        using the last tick for each symbol — avoids redundant evaluations
        when 20 ticks for the same symbol arrive in one 150ms batch.
        """
        if not self._ready:
            return

        # Collapse to one price per symbol using the last tick in the batch
        latest: dict[str, dict] = {}
        for t in ticks:
            sym = t.get("symbol")
            if sym:
                latest[sym] = t

        for sym, t in latest.items():
            bid = t.get("bid", 0.0)
            ask = t.get("ask", 0.0)
            if bid and ask:
                self._eval_tick(conn_id, sym, (bid + ask) / 2.0)

    def on_candle_close(self, conn_id: str, symbol: str, bar: dict) -> None:
        """
        Called by price_relay for every /candle-close payload.
        bar = {"t": int, "o": float, "h": float, "l": float, "c": float, "v": int}

        Detects H1 boundary and fires candle-close evaluation.
        """
        if not self._ready:
            return

        bar_time = bar.get("t", 0)
        if not bar_time:
            return

        # H1 close: use broker-native H1 candles from MT5 (single source of truth)
        self._eval_h1_close_from_mt5(conn_id, symbol)

        # Structure evaluation: only on user timeframe candle closes, only while STALKING
        self._eval_structure(conn_id, symbol, int(bar_time))

    def _eval_h1_close_from_mt5(self, conn_id: str, symbol: str) -> None:
        """Detect new closed H1 candle using broker-native candles and evaluate rules."""
        _ensure_path()
        try:
            from runtime.mt5_candles import get_broker_candles

            bars = get_broker_candles(conn_id, symbol, "1h", count=2)
        except Exception as exc:
            # If MT5 is unavailable, do not guess H1 boundaries.
            log.debug("[setup_manager] H1 MT5 fetch skipped (%s %s): %r", conn_id[:8], symbol, exc)
            return

        if not bars:
            return

        last = bars[-1]
        h1_time = int(last.get("t", 0) or 0)
        h1_close = float(last.get("c", 0.0) or 0.0)
        if not h1_time or not h1_close:
            return

        key = (conn_id, symbol)
        if self._last_h1_close_time_by_key.get(key) == h1_time:
            return
        self._last_h1_close_time_by_key[key] = h1_time

        log.info("[setup_manager] H1 close (MT5): %s t=%d close=%.5f", symbol, h1_time, h1_close)
        self._eval_h1_close(conn_id, symbol, h1_close, h1_time)

    # ------------------------------------------------------------------ #
    # Internal: structure / CHOCH-BOS evaluation                           #
    # ------------------------------------------------------------------ #
    def _eval_structure(self, conn_id: str, symbol: str, bar_time_1m_open: int) -> None:
        from ai_engine.setup_engine import STALKING
        from ai_engine.structure.choch_bos import analyze_structure, detect_choch_bos_event

        # Ensure repo root is importable so `runtime.*` imports work.
        _ensure_path()
        from runtime.mt5_candles import get_broker_candles

        # Snapshot relevant setups (minimise time under lock)
        with self._lock:
            setups = [
                (setup_id, setup)
                for setup_id, setup in self._setups.items()
                if setup.connection_id == conn_id
                and setup.symbol == symbol
                and setup.state == STALKING
            ]

        if not setups:
            return

        # Group by timeframe to avoid recomputing aggregated bars
        by_tf: dict[str, list[tuple[str, object]]] = {}
        for setup_id, setup in setups:
            tf = (getattr(setup, "timeframe", None) or "5m").strip()
            if tf not in TF_ALLOWED:
                tf = "5m"
            by_tf.setdefault(tf, []).append((setup_id, setup))

        for tf, group in by_tf.items():
            # Use broker-native candles for this timeframe (no synthetic aggregation).
            # First, a cheap tail fetch to see if a new closed candle exists.
            key = (conn_id, symbol, tf)
            tail = get_broker_candles(conn_id, symbol, tf, count=3)
            if len(tail) < 2:
                continue
            last_closed_t = int(tail[-1]["t"])
            if self._last_structure_eval_time_by_key.get(key) == last_closed_t:
                continue
            self._last_structure_eval_time_by_key[key] = last_closed_t

            bars = get_broker_candles(conn_id, symbol, tf, count=200)
            # Defensive: enforce ascending ordering.
            bars.sort(key=lambda b: int(b.get("t", 0) or 0))

            # Guard: do not run structure logic on short history.
            if len(bars) < STRUCTURE_MIN_BARS:
                continue

            # Detect event once per setup (dedupe per setup_id + candle_time)
            for setup_id, setup in group:
                ai_sensitivity = int(getattr(setup, "ai_sensitivity", 5) or 5)
                pivot_window = _pivot_window_from_ai_sensitivity(ai_sensitivity)
                analysis = analyze_structure(bars, pivot_window=pivot_window)
                if analysis is not None:
                    last_log_t = self._last_structure_analysis_time.get(setup_id)
                    if last_log_t != analysis.candle_time:
                        self._last_structure_analysis_time[setup_id] = analysis.candle_time
                        log.info(
                            "[structure] SYMBOL=%s TF=%s STATE=STALKING AI_SENSITIVITY=%d PIVOT_WINDOW=%d",
                            symbol,
                            tf,
                            int(ai_sensitivity),
                            int(pivot_window),
                        )
                        log.info(
                            "[structure] SwingHigh=%s SwingLow=%s LastClose=%.5f CandleTime=%d",
                            (f"{analysis.swing_high:.5f}" if analysis.swing_high is not None else "None"),
                            (f"{analysis.swing_low:.5f}" if analysis.swing_low is not None else "None"),
                            float(analysis.close_price),
                            int(analysis.candle_time),
                        )

                evt = detect_choch_bos_event(
                    bars,
                    side=getattr(setup, "side", ""),
                    pivot_window=pivot_window,
                )
                if not evt:
                    continue

                last_t = self._last_structure_event_time.get(setup_id)
                if last_t == evt.candle_time:
                    continue
                self._last_structure_event_time[setup_id] = evt.candle_time

                self._queue_structure_event(
                    setup_id=setup_id,
                    event_type=evt.event_type,
                    break_dir=evt.break_dir,
                    timeframe=tf,
                    level=evt.level,
                    close_price=evt.close_price,
                    candle_time=evt.candle_time,
                )
                log.info(
                    "[structure] Signal=%s_%s BreakPrice=%.5f CandleTime=%d",
                    ("BULLISH" if evt.break_dir == "bull" else "BEARISH"),
                    evt.event_type,
                    float(evt.close_price),
                    int(evt.candle_time),
                )

    # ------------------------------------------------------------------ #
    # Internal: state evaluation                                           #
    # ------------------------------------------------------------------ #

    def _eval_tick(self, conn_id: str, symbol: str, price: float) -> None:
        """Evaluate tick rules for all setups matching conn_id + symbol."""
        from ai_engine.setup_engine import evaluate_tick, DEAD  # local import — fast after first call

        with self._lock:
            for setup_id, setup in list(self._setups.items()):
                if setup.connection_id != conn_id or setup.symbol != symbol:
                    continue
                if setup.state == DEAD:
                    continue  # T1: ticks blocked for DEAD setups

                new_state = evaluate_tick(setup, price)
                if new_state != setup.state:
                    old_state    = setup.state
                    setup.state  = new_state
                    self._queue_write(setup_id, new_state, old_state, "tick", price, None)
                    log.info(
                        "[setup_manager] %s %s  %s → %s  tick @ %.5f",
                        setup.symbol, setup_id[:8], old_state, new_state, price,
                    )

                    if new_state == "STALKING":
                        try:
                            self._log_structure_snapshot(conn_id, setup_id, setup)
                        except Exception:
                            pass

    def _log_structure_snapshot(self, conn_id: str, setup_id: str, setup: object) -> None:
        """One-off structure snapshot for manual validation (called on STALKING entry)."""
        from ai_engine.structure.choch_bos import analyze_structure

        _ensure_path()
        from runtime.mt5_candles import get_broker_candles

        symbol = str(getattr(setup, "symbol", "") or "").strip()
        tf = str(getattr(setup, "timeframe", "") or "5m").strip().lower()
        if tf not in TF_ALLOWED:
            tf = "5m"

        ai_sensitivity = int(getattr(setup, "ai_sensitivity", 5) or 5)
        pivot_window = _pivot_window_from_ai_sensitivity(ai_sensitivity)

        bars = get_broker_candles(conn_id, symbol, tf, count=200)
        bars.sort(key=lambda b: int(b.get("t", 0) or 0))
        if len(bars) < STRUCTURE_MIN_BARS:
            return

        analysis = analyze_structure(bars, pivot_window=pivot_window)
        if analysis is None:
            return

        log.info(
            "[structure] SYMBOL=%s TF=%s STATE=STALKING AI_SENSITIVITY=%d PIVOT_WINDOW=%d (enter)",
            symbol,
            tf,
            int(ai_sensitivity),
            int(pivot_window),
        )
        log.info(
            "[structure] SwingHigh=%s SwingLow=%s LastClose=%.5f CandleTime=%d",
            (f"{analysis.swing_high:.5f}" if analysis.swing_high is not None else "None"),
            (f"{analysis.swing_low:.5f}" if analysis.swing_low is not None else "None"),
            float(analysis.close_price),
            int(analysis.candle_time),
        )

    def _eval_h1_close(
        self,
        conn_id:       str,
        symbol:        str,
        h1_close:      float,
        h1_candle_time: int,
    ) -> None:
        """Evaluate H1 candle-close rules for all setups matching conn_id + symbol."""
        from ai_engine.setup_engine import evaluate_candle, DEAD

        with self._lock:
            for setup_id, setup in list(self._setups.items()):
                if setup.connection_id != conn_id or setup.symbol != symbol:
                    continue

                new_state = evaluate_candle(setup, h1_close, h1_candle_time)
                old_state = setup.state

                if new_state != old_state:
                    # If dying now, record the trigger candle time for resurrection (C2)
                    if new_state == DEAD:
                        setup.dead_trigger_candle_time = h1_candle_time

                    setup.state = new_state
                    self._queue_write(
                        setup_id, new_state, old_state,
                        "h1_close", h1_close, h1_candle_time,
                    )
                    log.info(
                        "[setup_manager] %s %s  %s → %s  H1-close @ %.5f (t=%d)",
                        setup.symbol, setup_id[:8],
                        old_state, new_state,
                        h1_close, h1_candle_time,
                    )

    # ------------------------------------------------------------------ #
    # Background: Supabase refresh loop                                    #
    # ------------------------------------------------------------------ #

    def _refresh_loop(self) -> None:
        """Reload active setups from Supabase every REFRESH_INTERVAL_S."""
        while True:
            try:
                self._load_setups()
            except Exception as exc:
                log.warning("[setup_manager] refresh error: %r", exc)
            time.sleep(REFRESH_INTERVAL_S)

    def _load_setups(self) -> None:
        from ai_engine.setup_engine import build_setup_from_row

        db   = self._get_db()
        rows = (
            db.table("trading_setups")
              .select("*")
              .eq("is_active", True)
              .execute()
              .data
        ) or []

        with self._lock:
            # Preserve in-memory state for setups we already have
            # (prevents a refresh from resetting a state that just changed)
            new_setups: dict = {}
            for row in rows:
                sid = row["id"]
                if sid in self._setups:
                    # Already tracking — update zone/config fields but keep current state
                    existing = self._setups[sid]
                    existing.zone_low    = float(row["zone_low"])
                    existing.zone_high   = float(row["zone_high"])
                    existing.loss_edge   = float(row["loss_edge"])
                    existing.target      = float(row["target"])
                    existing.entry_price = float(row["entry_price"])
                    existing.timeframe   = (row.get("timeframe") or "5m")
                    existing.ai_sensitivity = int(row.get("ai_sensitivity") or getattr(existing, "ai_sensitivity", 5) or 5)
                    new_setups[sid]      = existing
                else:
                    # New setup — build fresh from DB row
                    try:
                        setup = build_setup_from_row(row)
                        new_setups[sid] = setup
                    except Exception as exc:
                        log.warning("[setup_manager] bad row %s: %r", row.get("id"), exc)
            self._setups = new_setups
            self._ready  = True

        log.info("[setup_manager] loaded %d active setups", len(rows))

    # ------------------------------------------------------------------ #
    # Background: async Supabase writer                                    #
    # ------------------------------------------------------------------ #

    def _queue_write(
        self,
        setup_id:    str,
        new_state:   str,
        old_state:   str,
        trigger:     str,
        price:       float,
        candle_time: Optional[int],
    ) -> None:
        """Non-blocking enqueue.  Drops silently if queue is full."""
        try:
            self._write_q.put_nowait({
                "type":       "state",
                "setup_id":    setup_id,
                "new_state":   new_state,
                "old_state":   old_state,
                "trigger":     trigger,
                "price":       price,
                "candle_time": candle_time,
            })
        except queue.Full:
            log.warning(
                "[setup_manager] write queue full — dropped %s %s→%s",
                setup_id[:8], old_state, new_state,
            )

    def _queue_structure_event(
        self,
        setup_id: str,
        event_type: str,
        break_dir: str,
        timeframe: str,
        level: float,
        close_price: float,
        candle_time: int,
    ) -> None:
        try:
            self._write_q.put_nowait({
                "type":        "structure",
                "setup_id":     setup_id,
                "event_type":   event_type,
                "break_dir":    break_dir,
                "timeframe":    timeframe,
                "level":        float(level),
                "close_price":  float(close_price),
                "candle_time":  int(candle_time),
            })
        except queue.Full:
            log.warning(
                "[setup_manager] write queue full — dropped structure event for %s",
                setup_id[:8],
            )

    def _write_loop(self) -> None:
        """Drain the write queue and persist each state change to Supabase."""
        while True:
            item = self._write_q.get()
            try:
                self._persist(item)
            except Exception as exc:
                log.error("[setup_manager] persist error: %r", exc)
            finally:
                self._write_q.task_done()

    def _persist(self, item: dict) -> None:
        """Write state change + audit row to Supabase (runs in writer thread)."""
        db        = self._get_db()
        kind = item.get("type", "state")

        if kind == "state":
            setup_id  = item["setup_id"]
            new_state = item["new_state"]

            # 1. Update the setup's current state
            update_payload: dict = {"state": new_state}
            if new_state == "DEAD" and item.get("candle_time"):
                update_payload["dead_trigger_candle_time"] = item["candle_time"]

            db.table("trading_setups") \
              .update(update_payload) \
              .eq("id", setup_id) \
              .execute()

            # 2. Append an audit row
            transition_row: dict = {
                "setup_id":    setup_id,
                "from_state":  item["old_state"],
                "to_state":    new_state,
                "trigger":     item["trigger"],   # 'tick' | 'h1_close'
                "price":       item["price"],
            }
            if item.get("candle_time"):
                transition_row["candle_time"] = item["candle_time"]

            db.table("setup_state_transitions") \
              .insert(transition_row) \
              .execute()

            log.debug(
                "[setup_manager] persisted %s %s → %s via %s",
                setup_id[:8], item["old_state"], new_state, item["trigger"],
            )
            return

        if kind == "structure":
            row = {
                "setup_id":    item["setup_id"],
                "event_type":  item["event_type"],
                "break_dir":   item["break_dir"],
                "timeframe":   item["timeframe"],
                "level":       item["level"],
                "close_price": item["close_price"],
                "candle_time": item["candle_time"],
            }
            db.table("setup_structure_events").insert(row).execute()
            return

    # ------------------------------------------------------------------ #
    # Supabase client                                                      #
    # ------------------------------------------------------------------ #

    def _get_db(self):
        if self._db is None:
            _ensure_path()
            # Import db_client from the runtime/ sibling directory
            runtime_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "runtime",
            )
            if runtime_dir not in sys.path:
                sys.path.insert(0, runtime_dir)
            import db_client
            self._db = db_client.get_client()
        return self._db

    # ------------------------------------------------------------------ #
    # Introspection helpers (useful for /health endpoint)                  #
    # ------------------------------------------------------------------ #

    def summary(self) -> dict:
        """Return a count of setups per state (thread-safe snapshot)."""
        counts: dict[str, int] = {}
        with self._lock:
            for s in self._setups.values():
                counts[s.state] = counts.get(s.state, 0) + 1
        return {"total": sum(counts.values()), "by_state": counts}


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

setup_manager = SetupManager()

# Auto-start when the module is imported inside the relay process
# (Supabase env-var check prevents accidental start in tests without creds)
setup_manager.start()
