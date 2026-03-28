from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


BLS_SCHEDULE_URL = "https://www.bls.gov/schedule/2026/home.htm"


@dataclass(frozen=True, slots=True)
class BLSReleaseMapping:
    event_code: str
    category: str
    country: str = "US"
    currency: str = "USD"
    region: str = "North America"


DEFAULT_BLS_MAPPINGS: dict[str, BLSReleaseMapping] = {
    "Employment Situation": BLSReleaseMapping("NFP", "labor"),
    "Consumer Price Index": BLSReleaseMapping("CPI", "inflation"),
    "Producer Price Index": BLSReleaseMapping("PPI", "inflation"),
    "Initial Claims": BLSReleaseMapping("INITIAL_CLAIMS", "labor"),
    "Unemployment Rate": BLSReleaseMapping("UNEMPLOYMENT", "labor"),
    "Nonfarm Payrolls": BLSReleaseMapping("NFP", "labor"),
    "Retail Sales": BLSReleaseMapping("RETAIL_SALES", "consumption"),
    "Durable Goods Orders": BLSReleaseMapping("DURABLE_GOODS", "consumption"),
    "Industrial Production": BLSReleaseMapping("INDUSTRIAL_PRODUCTION", "growth"),
}


class BLSProvider(EconomicCalendarProvider):
    """
    BLS provider using a static/cached schedule for 2026.
    In production, this would parse the official BLS schedule page.
    """

    name = "bls"

    def __init__(self, release_mappings: dict[str, BLSReleaseMapping] | None = None) -> None:
        self._release_mappings = release_mappings or DEFAULT_BLS_MAPPINGS
        self._schedule = self._build_static_schedule()

    def fetch_events(self, request: ProviderFetchRequest) -> list[EconomicEvent]:
        events = []
        for release in self._schedule:
            event_dt = datetime.fromisoformat(release["date"])
            # Ensure timezone-aware comparison
            if event_dt.tzinfo is None:
                event_dt = event_dt.replace(tzinfo=UTC)
            if request.start_utc <= event_dt <= request.end_utc:
                events.append(self._normalize_release(release))
        return sorted(events, key=lambda e: e.scheduled_at_utc)

    def _normalize_release(self, item: dict[str, Any]) -> EconomicEvent:
        title = item["title"]
        mapping = self._release_mappings.get(title)
        event_code = mapping.event_code if mapping else self._slugify(title).upper()
        category = mapping.category if mapping else "macro"
        country = mapping.country if mapping else "US"
        currency = mapping.currency if mapping else "USD"

        scheduled_at = datetime.fromisoformat(item["date"])
        impact = infer_impact(title=title, category=category, country=country, currency=currency)
        event_id = f"bls-{event_code.lower()}-{scheduled_at.date().isoformat()}"

        return EconomicEvent(
            id=event_id,
            source="official",
            source_event_id=title,
            provider=self.name,
            country=country,
            currency=currency,
            category=category,
            title=title,
            event_code=event_code,
            scheduled_at_utc=scheduled_at,
            impact=impact,
            status=EventStatus.SCHEDULED,
            unit=None,
            region="North America",
            tags=("bls", category, currency.lower()),
            metadata={"source": "BLS", "url": BLS_SCHEDULE_URL},
        )

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())

    def _build_static_schedule(self) -> list[dict[str, Any]]:
        """Hardcoded 2026 BLS schedule for next-week demo."""
        return [
            # April 3, 2026 - High impact events
            {
                "date": "2026-04-03T08:30:00+00:00",
                "title": "Employment Situation",
                "description": "March 2026 nonfarm payrolls, unemployment rate",
            },
            {
                "date": "2026-04-03T08:30:00+00:00",
                "title": "Initial Claims",
                "description": "Weekly initial jobless claims",
            },
            # April 10, 2026
            {
                "date": "2026-04-10T08:30:00+00:00",
                "title": "Consumer Price Index",
                "description": "March 2026 CPI",
            },
            {
                "date": "2026-04-10T08:30:00+00:00",
                "title": "Initial Claims",
                "description": "Weekly initial jobless claims",
            },
            # April 14, 2026
            {
                "date": "2026-04-14T08:30:00+00:00",
                "title": "Producer Price Index",
                "description": "March 2026 PPI",
            },
        ]
