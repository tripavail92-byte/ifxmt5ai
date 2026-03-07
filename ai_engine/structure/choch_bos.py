from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


BreakDir = Literal["bull", "bear"]
EventType = Literal["CHOCH", "BOS"]


@dataclass(frozen=True)
class ChochBosEvent:
    event_type: EventType
    break_dir: BreakDir
    candle_time: int
    level: float
    close_price: float


@dataclass(frozen=True)
class StructureAnalysis:
    candle_time: int
    close_price: float
    pivot_window: int

    swing_high_time: Optional[int]
    swing_high: Optional[float]
    swing_low_time: Optional[int]
    swing_low: Optional[float]

    break_up: bool
    break_dn: bool


def _is_pivot_high(bars: list[dict], idx: int, window: int) -> bool:
    h = bars[idx]["h"]
    for j in range(idx - window, idx + window + 1):
        if j == idx:
            continue
        if bars[j]["h"] >= h:
            return False
    return True


def _is_pivot_low(bars: list[dict], idx: int, window: int) -> bool:
    l = bars[idx]["l"]
    for j in range(idx - window, idx + window + 1):
        if j == idx:
            continue
        if bars[j]["l"] <= l:
            return False
    return True


def _latest_confirmed_swing_levels(
    bars: list[dict],
    window: int,
) -> tuple[Optional[tuple[int, float]], Optional[tuple[int, float]]]:
    """Return (last_swing_high, last_swing_low) as (time, price).

    Pivots require `window` candles on both sides; the newest `window` candles
    are therefore not eligible to be *confirmed* pivots.
    """
    if window < 1:
        window = 1

    # Need enough bars to have at least one confirmed pivot
    if len(bars) < (2 * window + 3):
        return None, None

    last_idx = len(bars) - 1 - window
    start_idx = window

    last_high: Optional[tuple[int, float]] = None
    last_low: Optional[tuple[int, float]] = None

    for i in range(start_idx, last_idx + 1):
        if _is_pivot_high(bars, i, window):
            last_high = (int(bars[i]["t"]), float(bars[i]["h"]))
        if _is_pivot_low(bars, i, window):
            last_low = (int(bars[i]["t"]), float(bars[i]["l"]))

    return last_high, last_low


def analyze_structure(
    bars: list[dict],
    *,
    pivot_window: int = 2,
) -> Optional[StructureAnalysis]:
    """Compute latest confirmed swing levels and whether the last close breaks them.

    This is a pure helper for observability + validation.
    It does not map to CHOCH/BOS (that depends on setup side).
    """
    if not bars:
        return None

    if pivot_window < 1:
        pivot_window = 1

    last = bars[-1]
    candle_time = int(last.get("t", 0) or 0)
    close_price = float(last.get("c", 0.0) or 0.0)
    if not candle_time:
        return None

    swing_high, swing_low = _latest_confirmed_swing_levels(bars, pivot_window)

    swing_high_time: Optional[int] = None
    swing_high_level: Optional[float] = None
    swing_low_time: Optional[int] = None
    swing_low_level: Optional[float] = None

    if swing_high is not None:
        swing_high_time = int(swing_high[0])
        swing_high_level = float(swing_high[1])

    if swing_low is not None:
        swing_low_time = int(swing_low[0])
        swing_low_level = float(swing_low[1])

    break_up = False
    break_dn = False
    if swing_high_level is not None:
        break_up = close_price > float(swing_high_level)
    if swing_low_level is not None:
        break_dn = close_price < float(swing_low_level)

    return StructureAnalysis(
        candle_time=candle_time,
        close_price=close_price,
        pivot_window=int(pivot_window),
        swing_high_time=swing_high_time,
        swing_high=swing_high_level,
        swing_low_time=swing_low_time,
        swing_low=swing_low_level,
        break_up=bool(break_up),
        break_dn=bool(break_dn),
    )


def detect_choch_bos_event(
    bars: list[dict],
    side: str,
    pivot_window: int = 2,
) -> Optional[ChochBosEvent]:
    """Detect a CHOCH/BOS break on the most recent *closed* candle.

    Rules (minimal, deterministic):
    - Compute latest confirmed swing high/low using a fractal pivot window.
    - If the latest candle CLOSE breaks above swing high → bull break.
    - If it CLOSE breaks below swing low  → bear break.
    - Map to BOS/CHOCH purely by the setup side:
        BUY:  bull break = BOS,  bear break = CHOCH
        SELL: bear break = BOS,  bull break = CHOCH

    Returns:
        ChochBosEvent or None.
    """
    if not bars:
        return None

    side_norm = (side or "").strip().lower()
    if side_norm not in {"buy", "sell"}:
        return None

    analysis = analyze_structure(bars, pivot_window=pivot_window)
    if analysis is None:
        return None

    candle_time = analysis.candle_time
    close_price = analysis.close_price

    swing_high = None
    swing_low = None
    if analysis.swing_high is not None and analysis.swing_high_time is not None:
        swing_high = (analysis.swing_high_time, analysis.swing_high)
    if analysis.swing_low is not None and analysis.swing_low_time is not None:
        swing_low = (analysis.swing_low_time, analysis.swing_low)

    if not swing_high and not swing_low:
        return None

    break_up = bool(analysis.break_up)
    break_dn = bool(analysis.break_dn)

    # Rare but possible if swings are stale or market gaps; prefer whichever
    # aligns with the setup side, otherwise take the larger-magnitude break.
    if break_up and break_dn:
        if side_norm == "buy":
            break_dn = False
        else:
            break_up = False

    if not break_up and not break_dn:
        return None

    if break_up and swing_high is not None:
        _, lvl = swing_high
        break_dir: BreakDir = "bull"
        event_type: EventType = "BOS" if side_norm == "buy" else "CHOCH"
        return ChochBosEvent(
            event_type=event_type,
            break_dir=break_dir,
            candle_time=candle_time,
            level=float(lvl),
            close_price=close_price,
        )

    if break_dn and swing_low is not None:
        _, lvl = swing_low
        break_dir = "bear"
        event_type = "BOS" if side_norm == "sell" else "CHOCH"
        return ChochBosEvent(
            event_type=event_type,
            break_dir=break_dir,
            candle_time=candle_time,
            level=float(lvl),
            close_price=close_price,
        )

    return None
