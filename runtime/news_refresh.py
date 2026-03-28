"""
news_refresh.py
IFX MT5 Runtime — Economic Calendar Refresh CLI.

Fetches events from all configured providers and:
  1. Stores them in local SQLite (calendar_cache.db)
  2. Upserts them to Supabase 'economic_events' table (for frontend display)

Usage:
  python news_refresh.py
  python news_refresh.py --days 30
  python news_refresh.py --dry-run     (local SQLite only, skip Supabase)

Optional env:
  FRED_API_KEY   — enables real-time FRED coverage (350+ US indicators)

Run this:
  - On startup / once per day via Task Scheduler
  - Before each trading week (e.g. Sunday night)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Ensure runtime package is importable when run directly
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("news_refresh")


def sync_to_supabase(events: list[dict]) -> int:
    """
    Upsert events into Supabase 'economic_events' table.
    Returns number of rows upserted, or 0 on failure.
    """
    if not events:
        return 0
    try:
        sys.path.insert(0, str(ROOT / "runtime"))
        from runtime import db_client as db  # type: ignore
        return db.upsert_economic_events(events)
    except Exception as exc:
        logger.warning("Supabase sync failed: %s", exc)
        return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh economic calendar cache")
    parser.add_argument("--days", type=int, default=14, help="Days ahead to fetch (default: 14)")
    parser.add_argument("--dry-run", action="store_true", help="Skip Supabase sync (local SQLite only)")
    args = parser.parse_args()

    logger.info("=== IFX Economic Calendar Refresh ===")
    logger.info("Days ahead: %d  |  Supabase sync: %s", args.days, "disabled (dry-run)" if args.dry_run else "enabled")

    if os.environ.get("FRED_API_KEY"):
        logger.info("FRED_API_KEY detected — FRED real-time data included")
    else:
        logger.info("No FRED_API_KEY — static providers only (ECB/ONS/BOJ/SNB/RBA/BOC/RBNZ/BLS)")

    # Lazy import so the package not being installed gives a clear error here
    try:
        from economic_calendar.engine import EconomicCalendarEngine  # type: ignore
        from economic_calendar.cache import EventCache  # type: ignore
    except ImportError:
        logger.error("economic-calendar package not installed.")
        logger.error("Run: pip install -e C:\\mt5system\\newbog\\newbog")
        sys.exit(1)

    from news_calendar import (  # type: ignore
        CALENDAR_DB,
        STATIC_PROVIDERS,
        refresh_calendar,
    )

    # ---------------------------------------------------------------------------
    # Step 1: Local SQLite refresh
    # ---------------------------------------------------------------------------
    logger.info("Refreshing local SQLite cache at %s ...", CALENDAR_DB)

    engine = EconomicCalendarEngine()
    cache = EventCache(str(CALENDAR_DB))

    now = datetime.now(UTC)
    end = now + timedelta(days=args.days)

    providers = list(STATIC_PROVIDERS)
    if os.environ.get("FRED_API_KEY"):
        providers.insert(0, "fred")

    all_events: list[dict] = []
    total = 0

    for provider in providers:
        try:
            events = engine.fetch(provider, now, end)
            cache.store_events(provider, events)
            total += len(events)
            logger.info("  %-6s → %d events", provider.upper(), len(events))
            for ev in events:
                all_events.append({
                    "id": ev.id,
                    "provider": ev.provider,
                    "currency": ev.currency,
                    "country": ev.country,
                    "title": ev.title,
                    "impact": ev.impact.value,
                    "scheduled_at_utc": ev.scheduled_at_utc.isoformat(),
                    "category": ev.category,
                    "event_json": ev.to_dict(),
                })
        except Exception as exc:
            logger.warning("  %-6s → FAILED: %s", provider.upper(), exc)

    logger.info("Local SQLite: %d total events across %d providers", total, len(providers))

    # ---------------------------------------------------------------------------
    # Step 2: Supabase sync (unless --dry-run)
    # ---------------------------------------------------------------------------
    if args.dry_run:
        logger.info("Dry-run mode — skipping Supabase sync")
    else:
        logger.info("Syncing %d events to Supabase economic_events table ...", len(all_events))
        synced = sync_to_supabase(all_events)
        if synced > 0:
            logger.info("Supabase: %d rows upserted", synced)
        else:
            logger.warning("Supabase sync returned 0 rows (table may not exist yet — run docs/economic_events_migration.sql)")

    # ---------------------------------------------------------------------------
    # Summary
    # ---------------------------------------------------------------------------
    logger.info("=== Refresh complete ===")
    logger.info("Events by impact:")
    high   = sum(1 for e in all_events if e["impact"] == "high")
    medium = sum(1 for e in all_events if e["impact"] == "medium")
    low    = sum(1 for e in all_events if e["impact"] == "low")
    logger.info("  HIGH=%d  MEDIUM=%d  LOW=%d", high, medium, low)

    # Print upcoming HIGH events for quick sanity check
    upcoming_high = sorted(
        [e for e in all_events if e["impact"] == "high"],
        key=lambda e: e["scheduled_at_utc"]
    )[:10]
    if upcoming_high:
        logger.info("Next HIGH impact events:")
        for ev in upcoming_high:
            logger.info("  %s  %-3s  %s", ev["scheduled_at_utc"][:16], ev["currency"], ev["title"])


if __name__ == "__main__":
    main()
