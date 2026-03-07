from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone


def _tf_minutes(tf: str) -> int:
    tf = (tf or "").strip().lower()
    if tf.endswith("m") and tf[:-1].isdigit():
        return int(tf[:-1])
    if tf.endswith("h") and tf[:-1].isdigit():
        return int(tf[:-1]) * 60
    if tf.endswith("d") and tf[:-1].isdigit():
        return int(tf[:-1]) * 60 * 24
    raise ValueError(f"unsupported timeframe: {tf}")


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


def _iso_utc(ts: int) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()


@dataclass(frozen=True)
class BreakEvent:
    t: int
    direction: str  # 'bull' | 'bear'
    close: float
    level: float


def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Scan recent broker-native candles and count bullish vs bearish structure breaks.\n"
            "Bullish break = close > latest confirmed swing high.\n"
            "Bearish break = close < latest confirmed swing low.\n\n"
            "Example:\n"
            "  python scan_structure_breaks.py --conn-id <CONN> --symbol BTCUSDm --tf 5m --hours 24 --ai-sensitivity 5"
        )
    )
    p.add_argument("--conn-id", required=True)
    p.add_argument("--symbol", default="BTCUSDm")
    p.add_argument("--tf", default="5m")
    p.add_argument("--hours", type=float, default=24.0)
    p.add_argument("--ai-sensitivity", type=int, default=5)
    p.add_argument(
        "--pivot-window",
        type=int,
        default=None,
        help=(
            "Override pivot window (fractal confirmation width). If omitted, derived from --ai-sensitivity. "
            "Example: --pivot-window 5"
        ),
    )
    p.add_argument("--extra-bars", type=int, default=250, help="Fetch extra history before the window.")
    p.add_argument("--show", type=int, default=25, help="Print up to N detected events.")
    p.add_argument(
        "--mode",
        choices=["all", "unique"],
        default="all",
        help=(
            "Counting mode: 'all' counts every candle that breaks a swing; "
            "'unique' counts only the first break per swing level (avoids streak overcount)."
        ),
    )
    args = p.parse_args()

    from runtime.mt5_candles import get_broker_candles
    from ai_engine.structure.choch_bos import analyze_structure

    tf = str(args.tf).strip().lower()
    minutes = _tf_minutes(tf)
    window_seconds = int(float(args.hours) * 3600)

    # Number of bars in the requested time window (closed candles).
    bars_in_window = int((float(args.hours) * 60.0) / float(minutes))
    if bars_in_window < 10:
        bars_in_window = 10

    fetch_count = int(bars_in_window + int(args.extra_bars))
    if fetch_count < 100:
        fetch_count = 100

    pivot_window = _pivot_window_from_ai_sensitivity(int(args.ai_sensitivity))
    if args.pivot_window is not None:
        pivot_window = int(args.pivot_window)
        if pivot_window < 1:
            pivot_window = 1
        if pivot_window > 50:
            pivot_window = 50

    bars = get_broker_candles(
        str(args.conn_id),
        str(args.symbol).strip(),
        tf,
        count=fetch_count,
        include_current=False,
    )
    bars.sort(key=lambda b: int(b.get("t", 0) or 0))

    if len(bars) < (2 * pivot_window + 3):
        print(f"Not enough bars to analyze (bars={len(bars)} pivot_window={pivot_window}).", flush=True)
        return 2

    end_t = int(bars[-1]["t"])
    start_t = end_t - window_seconds

    # Find first index inside the 24h window.
    start_idx = 0
    for i, b in enumerate(bars):
        if int(b.get("t", 0) or 0) >= start_t:
            start_idx = i
            break

    # Ensure we have enough warmup history for pivots.
    warmup_min = 2 * pivot_window + 3
    if start_idx < warmup_min:
        start_idx = warmup_min

    bull = 0
    bear = 0
    events: list[BreakEvent] = []

    last_bull_key: tuple[int, float] | None = None
    last_bear_key: tuple[int, float] | None = None

    for i in range(start_idx, len(bars)):
        prefix = bars[: i + 1]
        analysis = analyze_structure(prefix, pivot_window=pivot_window)
        if analysis is None:
            continue

        # Break flags are about the last candle in the prefix.
        if analysis.break_up and analysis.swing_high is not None and analysis.swing_high_time is not None:
            key = (int(analysis.swing_high_time), float(analysis.swing_high))
            should_count = True
            if str(args.mode) == "unique":
                should_count = (last_bull_key != key)
            if should_count:
                bull += 1
                last_bull_key = key
                events.append(
                    BreakEvent(
                        t=int(analysis.candle_time),
                        direction="bull",
                        close=float(analysis.close_price),
                        level=float(analysis.swing_high),
                    )
                )

        if analysis.break_dn and analysis.swing_low is not None and analysis.swing_low_time is not None:
            key = (int(analysis.swing_low_time), float(analysis.swing_low))
            should_count = True
            if str(args.mode) == "unique":
                should_count = (last_bear_key != key)
            if should_count:
                bear += 1
                last_bear_key = key
                events.append(
                    BreakEvent(
                        t=int(analysis.candle_time),
                        direction="bear",
                        close=float(analysis.close_price),
                        level=float(analysis.swing_low),
                    )
                )

    # Summary
    print("\n=== Structure Break Scan ===", flush=True)
    print(f"SYMBOL: {args.symbol}", flush=True)
    print(f"TF: {tf}", flush=True)
    print(f"HOURS: {args.hours}", flush=True)
    print(f"AI_SENSITIVITY: {args.ai_sensitivity}", flush=True)
    print(f"PIVOT_WINDOW: {pivot_window}", flush=True)
    print(f"MODE: {args.mode}", flush=True)
    print(f"BARS_FETCHED: {len(bars)}", flush=True)
    print(f"WINDOW_START: {start_t} ({_iso_utc(start_t)})", flush=True)
    print(f"WINDOW_END:   {end_t} ({_iso_utc(end_t)})", flush=True)
    print(f"BULLISH_BREAKS: {bull}", flush=True)
    print(f"BEARISH_BREAKS: {bear}", flush=True)

    if int(args.show) > 0 and events:
        print(f"\nFirst {min(int(args.show), len(events))} events:", flush=True)
        for ev in events[: int(args.show)]:
            print(
                f"- {ev.direction.upper()}  t={ev.t} ({_iso_utc(ev.t)})  close={ev.close:.2f}  level={ev.level:.2f}",
                flush=True,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
