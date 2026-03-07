from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone


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


def _fmt_price(v: float | None) -> str:
    if v is None:
        return "None"
    return f"{float(v):.5f}"


def _fmt_time_epoch(ts: int | None) -> str:
    if not ts:
        return "None"
    iso = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
    return f"{int(ts)} ({iso})"


@dataclass(frozen=True)
class Case:
    symbol: str
    timeframe: str
    ai_sensitivity: int
    side: str


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Manual validation runner for structure engine (CHOCH/BOS) on broker-native MT5 candles.\n"
            "No synthetic candles; closed candles only.\n\n"
            "Example:\n"
            "  python validate_structure_engine.py --conn-id <CONN> --symbols EURUSDm,XAUUSDm --timeframes 1m,5m --sensitivities 2,5,8 --side buy"
        )
    )
    parser.add_argument("--conn-id", required=True, help="MT5 connection_id folder under terminals/")
    parser.add_argument(
        "--symbols",
        default="EURUSDm,XAUUSDm",
        help="Comma-separated symbols (must match broker symbol names, e.g. EURUSDm).",
    )
    parser.add_argument(
        "--timeframes",
        default="1m,5m",
        help="Comma-separated timeframes (e.g. 1m,3m,5m,15m,30m,1h).",
    )
    parser.add_argument(
        "--sensitivities",
        default="2,5,8",
        help="Comma-separated AI sensitivity ints (e.g. 2,5,8).",
    )
    parser.add_argument(
        "--side",
        default="buy",
        choices=["buy", "sell"],
        help="Setup side used to map breaks into BOS vs CHOCH.",
    )
    parser.add_argument("--count", type=int, default=200, help="History bars to fetch.")
    parser.add_argument(
        "--skip-status",
        action="store_true",
        help="Skip initial MT5 status snapshot (useful if MT5 IPC blocks).",
    )

    args = parser.parse_args()

    from runtime.mt5_candles import get_broker_candles, get_mt5_status
    from ai_engine.structure.choch_bos import analyze_structure, detect_choch_bos_event

    conn_id = str(args.conn_id)
    symbols = [s.strip() for s in str(args.symbols).split(",") if s.strip()]
    timeframes = [t.strip().lower() for t in str(args.timeframes).split(",") if t.strip()]
    sensitivities = [int(x.strip()) for x in str(args.sensitivities).split(",") if x.strip()]
    side = str(args.side).strip().lower()

    if not bool(args.skip_status):
        print("\n=== MT5 Status Snapshot (first symbol/timeframe) ===", flush=True)
        try:
            if symbols and timeframes:
                status = get_mt5_status(conn_id, symbols[0], timeframes[0])
                print(status, flush=True)
        except Exception as e:
            print(f"MT5 status unavailable: {type(e).__name__}: {e}", flush=True)

    cases: list[Case] = []
    for sym in symbols:
        for tf in timeframes:
            for s in sensitivities:
                cases.append(Case(symbol=sym, timeframe=tf, ai_sensitivity=int(s), side=side))

    for c in cases:
        pivot_window = _pivot_window_from_ai_sensitivity(c.ai_sensitivity)
        bars = get_broker_candles(conn_id, c.symbol, c.timeframe, count=int(args.count), include_current=False)
        bars.sort(key=lambda b: int(b.get("t", 0) or 0))

        print("\n------------------------------------------------------------", flush=True)
        print(f"SYMBOL: {c.symbol}", flush=True)
        print(f"TF: {c.timeframe}", flush=True)
        print("STATE: STALKING (manual)", flush=True)
        print(f"AI_SENSITIVITY: {c.ai_sensitivity}", flush=True)
        print(f"PIVOT_WINDOW: {pivot_window}", flush=True)
        print(f"BARS: {len(bars)}", flush=True)

        if len(bars) < (2 * pivot_window + 3):
            print(
                "Insufficient history for confirmed pivots; increase --count or wait for more candles.",
                flush=True,
            )
            continue

        analysis = analyze_structure(bars, pivot_window=pivot_window)
        if analysis is None:
            print("No analysis (empty / invalid bars).", flush=True)
            continue

        print(
            f"Swing High: {_fmt_price(analysis.swing_high)} @ {_fmt_time_epoch(analysis.swing_high_time)}",
            flush=True,
        )
        print(
            f"Swing Low:  {_fmt_price(analysis.swing_low)} @ {_fmt_time_epoch(analysis.swing_low_time)}",
            flush=True,
        )
        print(
            f"Last Close: {_fmt_price(analysis.close_price)} @ {_fmt_time_epoch(analysis.candle_time)}",
            flush=True,
        )

        evt = detect_choch_bos_event(bars, side=c.side, pivot_window=pivot_window)
        if not evt:
            print("Signal: NONE", flush=True)
            continue

        signal = f"{('BULLISH' if evt.break_dir == 'bull' else 'BEARISH')}_{evt.event_type}"
        print(f"Signal: {signal}", flush=True)
        print(f"Break price: {evt.close_price:.5f}", flush=True)
        print(f"Candle time: {_fmt_time_epoch(evt.candle_time)}", flush=True)

    print("\nDone.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
