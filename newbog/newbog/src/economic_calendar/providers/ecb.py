from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


@dataclass(frozen=True, slots=True)
class ECBReleaseMapping:
    event_code: str
    category: str
    country: str = "EU"
    currency: str = "EUR"
    region: str = "Europe"


DEFAULT_ECB_MAPPINGS: dict[str, ECBReleaseMapping] = {
    "ECB Press Conference": ECBReleaseMapping("ECB_CONF", "central_bank"),
    "ECB Monetary Policy Decision": ECBReleaseMapping("ECB_MPD", "central_bank"),
    "ECB Interest Rate Decision": ECBReleaseMapping("ECB_RATE", "central_bank"),
    "German Manufacturing PMI": ECBReleaseMapping("DE_PMI_MFG", "growth"),
    "French Manufacturing PMI": ECBReleaseMapping("FR_PMI_MFG", "growth"),
    "Eurozone Manufacturing PMI": ECBReleaseMapping("EZ_PMI_MFG", "growth"),
    "German Services PMI": ECBReleaseMapping("DE_PMI_SVC", "growth"),
    "French Services PMI": ECBReleaseMapping("FR_PMI_SVC", "growth"),
    "Eurozone Services PMI": ECBReleaseMapping("EZ_PMI_SVC", "growth"),
    "German CPI": ECBReleaseMapping("DE_CPI", "inflation"),
    "French CPI": ECBReleaseMapping("FR_CPI", "inflation"),
    "Eurozone CPI": ECBReleaseMapping("EZ_CPI", "inflation"),
}


class ECBProvider(EconomicCalendarProvider):
    """ECB provider using a static schedule for 2026 demo."""

    name = "ecb"

    def __init__(self, release_mappings: dict[str, ECBReleaseMapping] | None = None) -> None:
        self._release_mappings = release_mappings or DEFAULT_ECB_MAPPINGS
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
        country = mapping.country if mapping else "EU"
        currency = mapping.currency if mapping else "EUR"

        scheduled_at = datetime.fromisoformat(item["date"])
        impact = infer_impact(title=title, category=category, country=country, currency=currency)
        event_id = f"ecb-{event_code.lower()}-{scheduled_at.date().isoformat()}"

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
            region="Europe",
            tags=("ecb", category, currency.lower()),
            metadata={"source": "ECB", "url": "https://www.ecb.europa.eu/press/calendar/html/index.en.html"},
        )

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())

    def _build_static_schedule(self) -> list[dict[str, Any]]:
        """Eurozone next-week high-impact events from ECB/official sources."""
        return [
            {
                "date": "2026-03-24T04:30:00+00:00",
                "title": "German Manufacturing PMI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-24T05:00:00+00:00",
                "title": "Eurozone Manufacturing PMI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-24T04:15:00+00:00",
                "title": "French Manufacturing PMI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-31T11:45:00+00:00",
                "title": "German Manufacturing PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-03-31T12:00:00+00:00",
                "title": "Eurozone Manufacturing PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-03-31T13:00:00+00:00",
                "title": "French Manufacturing PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-04-01T10:00:00+00:00",
                "title": "German Services PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-04-01T11:00:00+00:00",
                "title": "Eurozone Services PMI",
                "description": "Final March 2026",
            },
        ]
