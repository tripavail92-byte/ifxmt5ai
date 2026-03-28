from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


@dataclass(frozen=True, slots=True)
class RBAReleaseMapping:
    event_code: str
    category: str
    country: str = "AU"
    currency: str = "AUD"
    region: str = "Asia-Pacific"


DEFAULT_RBA_MAPPINGS: dict[str, RBAReleaseMapping] = {
    "RBA Interest Rate Decision": RBAReleaseMapping("RBA_RATE", "central_bank"),
    "Australia CPI": RBAReleaseMapping("AU_CPI", "inflation"),
    "Australia Manufacturing PMI": RBAReleaseMapping("AU_PMI_MFG", "growth"),
    "Australia Services PMI": RBAReleaseMapping("AU_PMI_SVC", "growth"),
    "Australia Employment Change": RBAReleaseMapping("AU_EMPLOYMENT", "labor"),
}


class RBAProvider(EconomicCalendarProvider):
    """Reserve Bank of Australia provider using a static schedule for 2026 demo."""

    name = "rba"

    def __init__(self, release_mappings: dict[str, RBAReleaseMapping] | None = None) -> None:
        self._release_mappings = release_mappings or DEFAULT_RBA_MAPPINGS
        self._schedule = self._build_static_schedule()

    def fetch_events(self, request: ProviderFetchRequest) -> list[EconomicEvent]:
        events = []
        for release in self._schedule:
            event_dt = datetime.fromisoformat(release["date"])
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
        country = mapping.country if mapping else "AU"
        currency = mapping.currency if mapping else "AUD"

        scheduled_at = datetime.fromisoformat(item["date"])
        impact = infer_impact(title=title, category=category, country=country, currency=currency)
        event_id = f"rba-{event_code.lower()}-{scheduled_at.date().isoformat()}"

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
            region="Asia-Pacific",
            tags=("rba", category, currency.lower()),
            metadata={"source": "Reserve Bank of Australia", "url": "https://www.rba.gov.au/"},
        )

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())

    def _build_static_schedule(self) -> list[dict[str, Any]]:
        """Australia next-week economic indicators."""
        return [
            {
                "date": "2026-04-01T02:00:00+00:00",
                "title": "Australia Manufacturing PMI",
                "description": "Final March 2026",
            },
        ]
