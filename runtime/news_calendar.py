"""
news_calendar.py
IFX MT5 Runtime — Economic calendar integration.

Wraps the economic-calendar package to provide:
  - refresh_calendar(days_ahead)  → fetch all providers → local SQLite + Supabase
  - is_news_blocked(symbol, before_min, after_min) → (bool, reason | None)
  - get_upcoming_events(hours, currencies, impacts) → list[dict]

Setup:
  The economic-calendar package is installed editable from:
  C:\\mt5system\\newbog\\newbog  (pip install -e .)

Optional:
  Set FRED_API_KEY env var for real-time FRED (350+ US indicators).
  Without it, static providers still give ECB/ONS/BOJ/SNB/RBA/BOC/RBNZ/BLS coverage.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Local SQLite cache — lives next to the runtime, not in venv
CALENDAR_DB = Path(__file__).parent.parent / "calendar_cache.db"

# Static providers that work without any API key
STATIC_PROVIDERS = ["ecb", "ons", "boj", "snb", "rba", "boc", "rbnz", "bls"]

# Currency pairs → relevant currencies (also handles broker suffixes like EURUSDm)
SYMBOL_CURRENCIES: dict[str, tuple[str, ...]] = {
    "EURUSD": ("EUR", "USD"),
    "GBPUSD": ("GBP", "USD"),
    "USDJPY": ("USD", "JPY"),
    "AUDUSD": ("AUD", "USD"),
    "NZDUSD": ("NZD", "USD"),
    "USDCAD": ("USD", "CAD"),
    "USDCHF": ("USD", "CHF"),
    "EURJPY": ("EUR", "JPY"),
    "GBPJPY": ("GBP", "JPY"),
    "EURGBP": ("EUR", "GBP"),
    "EURAUD": ("EUR", "AUD"),
    "GBPAUD": ("GBP", "AUD"),
    "AUDCAD": ("AUD", "CAD"),
    "AUDNZD": ("AUD", "NZD"),
    "NZDCAD": ("NZD", "CAD"),
    "USDNOK": ("USD", "NOK"),
    "USDSEK": ("USD", "SEK"),
    "XAUUSD": ("USD",),
    "XAGUSD": ("USD",),
    "US30":   ("USD",),
    "US500":  ("USD",),
    "NAS100": ("USD",),
    "GER40":  ("EUR",),
    "UK100":  ("GBP",),
}


# ---------------------------------------------------------------------------
# Lazy loader helpers
# ---------------------------------------------------------------------------

def _get_engine():
    """Return EconomicCalendarEngine or None if package missing."""
    try:
        from economic_calendar.engine import EconomicCalendarEngine  # type: ignore
        return EconomicCalendarEngine()
    except ImportError as exc:
        logger.error("economic-calendar package not installed: %s. Run: pip install -e C:\\mt5system\\newbog\\newbog", exc)
        return None


def _get_cache():
    """Return EventCache backed by the shared SQLite file, or None."""
    try:
        from economic_calendar.cache import EventCache  # type: ignore
        return EventCache(str(CALENDAR_DB))
    except ImportError as exc:
        logger.error("economic-calendar package not installed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def refresh_calendar(days_ahead: int = 14) -> int:
    """
    Fetch events from all available providers and store in local SQLite.

    Also returns the list of raw event dicts for optional Supabase sync.
    Returns total event count stored.
    """
    engine = _get_engine()
    cache = _get_cache()
    if not engine or not cache:
        return 0

    now = datetime.now(UTC)
    end = now + timedelta(days=days_ahead)

    providers = list(STATIC_PROVIDERS)
    if os.environ.get("FRED_API_KEY"):
        providers.insert(0, "fred")
        logger.info("FRED_API_KEY found — including FRED provider")
    else:
        logger.info("No FRED_API_KEY — using static providers only (ECB/ONS/BOJ/SNB/RBA/BOC/RBNZ/BLS)")

    total = 0
    all_events: list[dict[str, Any]] = []

    for provider in providers:
        try:
            events = engine.fetch(provider, now, end)
            cache.store_events(provider, events)
            total += len(events)
            logger.info("Calendar refresh: %s → %d events", provider, len(events))
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
            logger.warning("Calendar provider %s failed: %s", provider, exc)

    logger.info("Calendar refresh complete: %d total events from %d providers", total, len(providers))
    return total


def get_upcoming_events(
    hours: int = 48,
    currencies: list[str] | None = None,
    impacts: list[str] | None = None,
) -> list[dict[str, Any]]:
    """
    Query cached events for display in the terminal UI.
    Returns list of dicts from EventCache.get_events().
    """
    cache = _get_cache()
    if not cache:
        return []

    now = datetime.now(UTC)
    end = now + timedelta(hours=hours)

    return cache.get_events(
        start_utc=now,
        end_utc=end,
        currencies=currencies,
        impacts=impacts or ["high", "medium"],
    )


def is_news_blocked(
    symbol: str,
    before_min: int = 30,
    after_min: int = 30,
) -> tuple[bool, str | None]:
    """
    Check if current UTC time falls within a news blackout window for the given symbol.

    - before_min: block N minutes BEFORE a high-impact event
    - after_min:  block N minutes AFTER  a high-impact event

    Returns (True, reason) if blocked, (False, None) if clear.
    Silently returns (False, None) if the calendar package is unavailable
    or the cache is empty — fail-open so market orders still work.
    """
    cache = _get_cache()
    if not cache:
        return False, None

    now = datetime.now(UTC)

    # Fetch events in the combined window
    max_window = max(before_min, after_min)
    window_start = now - timedelta(minutes=max_window)
    window_end = now + timedelta(minutes=max_window)

    # Resolve currencies from symbol (strip broker suffix like EURUSDm)
    currencies = _resolve_currencies(symbol)

    try:
        events_raw = cache.get_events(
            start_utc=window_start,
            end_utc=window_end,
            impacts=["high"],
            currencies=currencies,
        )
    except Exception as exc:
        logger.warning("news_calendar cache query failed: %s", exc)
        return False, None

    if not events_raw:
        return False, None

    for ev in events_raw:
        try:
            ev_time = _parse_dt(ev.get("scheduled_at_utc", ""))
            if ev_time is None:
                continue

            minutes_to = (ev_time - now).total_seconds() / 60

            # Upcoming event — within before_min window
            if 0 <= minutes_to <= before_min:
                reason = (
                    f"News blackout: {ev.get('currency','?')} high-impact event in "
                    f"{int(minutes_to)}min — {ev.get('title','?')}"
                )
                return True, reason

            # Past event — within after_min window
            if -after_min <= minutes_to < 0:
                reason = (
                    f"News blackout: {ev.get('currency','?')} high-impact event "
                    f"{abs(int(minutes_to))}min ago — {ev.get('title','?')}"
                )
                return True, reason

        except Exception as exc:
            logger.debug("Error processing news event: %s", exc)
            continue

    return False, None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _resolve_currencies(symbol: str) -> list[str] | None:
    """
    Return the list of currencies relevant for a given symbol string.
    Handles broker suffix variants (EURUSDm, EURUSD.raw, etc.).
    Returns None if symbol not recognized (no currency filter applied).
    """
    sym_upper = symbol.upper()
    for key, currencies in SYMBOL_CURRENCIES.items():
        if sym_upper == key or sym_upper.startswith(key):
            return list(currencies)
    # Try raw 6-char trim (e.g. "EURUSDm" → "EURUSD")
    stripped = sym_upper[:6]
    if stripped in SYMBOL_CURRENCIES:
        return list(SYMBOL_CURRENCIES[stripped])
    return None


def _parse_dt(value: str) -> datetime | None:
    """Parse ISO datetime string to UTC-aware datetime."""
    if not value:
        return None
    try:
        from dateutil.parser import isoparse  # type: ignore
        dt = isoparse(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None
