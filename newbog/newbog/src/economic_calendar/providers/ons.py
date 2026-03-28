from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


@dataclass(frozen=True, slots=True)
class ONSReleaseMapping:
    event_code: str
    category: str
    country: str = "GB"
    currency: str = "GBP"
    region: str = "Europe"


DEFAULT_ONS_MAPPINGS: dict[str, ONSReleaseMapping] = {
    "Bank of England MPC Decision": ONSReleaseMapping("BOE_MPC", "central_bank"),
    "Bank of England Interest Rate": ONSReleaseMapping("BOE_RATE", "central_bank"),
    "UK Manufacturing PMI": ONSReleaseMapping("UK_PMI_MFG", "growth"),
    "UK Services PMI": ONSReleaseMapping("UK_PMI_SVC", "growth"),
    "UK CPI": ONSReleaseMapping("UK_CPI", "inflation"),
    "UK Retail Sales": ONSReleaseMapping("UK_RETAIL", "consumption"),
    "UK Employment": ONSReleaseMapping("UK_EMPLOYMENT", "labor"),
    "UK Jobless Claims": ONSReleaseMapping("UK_JOBLESS", "labor"),
    "UK GDP": ONSReleaseMapping("UK_GDP", "growth"),
}


class ONSProvider(EconomicCalendarProvider):
    """ONS/BoE provider using a static schedule for 2026 demo."""

    name = "ons"

    def __init__(self, release_mappings: dict[str, ONSReleaseMapping] | None = None) -> None:
        self._release_mappings = release_mappings or DEFAULT_ONS_MAPPINGS
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
        country = mapping.country if mapping else "GB"
        currency = mapping.currency if mapping else "GBP"

        scheduled_at = datetime.fromisoformat(item["date"])
        impact = infer_impact(title=title, category=category, country=country, currency=currency)
        event_id = f"ons-{event_code.lower()}-{scheduled_at.date().isoformat()}"

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
            tags=("ons", category, currency.lower()),
            metadata={"source": "ONS/BoE", "url": "https://www.ons.gov.uk/"},
        )

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())

    def _build_static_schedule(self) -> list[dict[str, Any]]:
        """UK next-week high-impact events from ONS/BoE."""
        return [
            {
                "date": "2026-03-24T05:30:00+00:00",
                "title": "UK Manufacturing PMI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-24T05:30:00+00:00",
                "title": "UK Services PMI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-25T03:00:00+00:00",
                "title": "UK CPI",
                "description": "Flash March 2026",
            },
            {
                "date": "2026-03-27T03:00:00+00:00",
                "title": "UK Retail Sales",
                "description": "March 2026",
            },
            {
                "date": "2026-03-31T07:00:00+00:00",
                "title": "UK Manufacturing PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-03-31T08:30:00+00:00",
                "title": "UK Services PMI",
                "description": "Final March 2026",
            },
            {
                "date": "2026-04-01T10:30:00+00:00",
                "title": "UK Jobless Claims",
                "description": "March 2026",
            },
            {
                "date": "2026-04-02T08:00:00+00:00",
                "title": "Bank of England MPC Decision",
                "description": "Interest rate decision",
            },
            {
                "date": "2026-04-02T08:30:00+00:00",
                "title": "UK CPI",
                "description": "Final March 2026",
            },
        ]
