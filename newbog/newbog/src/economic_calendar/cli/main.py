from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import UTC, datetime
from typing import Any

from economic_calendar.cache import EventCache
from economic_calendar.engine import EconomicCalendarEngine


def _parse_date(value: str) -> datetime:
    if "T" in value:
        dt = datetime.fromisoformat(value)
        return dt.astimezone(UTC)
    return datetime.fromisoformat(f"{value}T00:00:00+00:00").astimezone(UTC)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="economic-calendar")
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_parser = subparsers.add_parser("fetch", help="Fetch normalized calendar events")
    fetch_parser.add_argument("--provider", default="fred")
    fetch_parser.add_argument("--from", dest="start", required=True)
    fetch_parser.add_argument("--to", dest="end", required=True)

    block_parser = subparsers.add_parser("should-block", help="Evaluate trade blackout window")
    block_parser.add_argument("--symbol", required=True)
    block_parser.add_argument("--timestamp", required=True)
    block_parser.add_argument("--provider", default="fred")
    block_parser.add_argument("--from", dest="start", required=False)
    block_parser.add_argument("--to", dest="end", required=False)

    export_parser = subparsers.add_parser("filter-export", help="Filter and export events from cache")
    export_parser.add_argument("--from", dest="start", required=True)
    export_parser.add_argument("--to", dest="end", required=True)
    export_parser.add_argument("--currencies", default="EUR,USD,GBP", help="comma-separated currencies")
    export_parser.add_argument("--impacts", default="high", help="comma-separated impact levels")
    export_parser.add_argument("--providers", default="fred,bls", help="comma-separated providers")
    export_parser.add_argument("--format", default="json", choices=["json", "csv"])
    export_parser.add_argument("--cache-db", default="calendar_cache.db", help="path to cache database")
    export_parser.add_argument("--fetch-fresh", action="store_true", help="fetch and cache before exporting")

    return parser



def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    engine = EconomicCalendarEngine()

    if args.command == "fetch":
        events = engine.fetch(args.provider, _parse_date(args.start), _parse_date(args.end))
        print(json.dumps([event.to_dict() for event in events], indent=2))
        return 0

    if args.command == "should-block":
        timestamp = _parse_date(args.timestamp)
        start = _parse_date(args.start) if args.start else datetime.combine(timestamp.date(), datetime.min.time(), tzinfo=UTC)
        end = _parse_date(args.end) if args.end else datetime.combine(timestamp.date(), datetime.max.time(), tzinfo=UTC)
        events = engine.fetch(args.provider, start, end)
        decision = engine.should_block(args.symbol, timestamp, events)
        payload: dict[str, Any] = {
            "should_block": decision.should_block,
            "reason": decision.reason,
            "minutes_to_event": decision.minutes_to_event,
            "event": decision.event.to_dict() if decision.event else None,
        }
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "filter-export":
        cache = EventCache(args.cache_db)
        start = _parse_date(args.start)
        end = _parse_date(args.end)
        providers = [p.strip() for p in args.providers.split(",")]
        currencies = [c.strip().upper() for c in args.currencies.split(",")]
        impacts = [i.strip().lower() for i in args.impacts.split(",")]

        # Optionally fetch fresh data first
        if args.fetch_fresh:
            for provider in providers:
                try:
                    events = engine.fetch(provider, start, end)
                    cache.store_events(provider, events)
                    cache.store_raw_payload(provider, start, end, [e.to_dict() for e in events])
                except Exception as e:
                    print(f"Warning: failed to fetch {provider}: {e}", flush=True)

        # Query cache
        results = cache.get_events(
            start_utc=start,
            end_utc=end,
            currencies=currencies,
            impacts=impacts,
            providers=providers,
        )

        # Sort by date
        results.sort(key=lambda x: x["scheduled_at_utc"])

        # Export
        if args.format == "json":
            print(json.dumps(results, indent=2))
        elif args.format == "csv":
            if results:
                writer = csv.DictWriter(
                    sys.stdout,
                    fieldnames=[
                        "scheduled_at_utc",
                        "currency",
                        "country",
                        "impact",
                        "title",
                        "provider",
                    ],
                )
                writer.writeheader()
                for row in results:
                    writer.writerow(
                        {
                            "scheduled_at_utc": row["scheduled_at_utc"],
                            "currency": row["currency"],
                            "country": row["country"],
                            "impact": row["impact"],
                            "title": row["title"],
                            "provider": row["provider"],
                        }
                    )
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
