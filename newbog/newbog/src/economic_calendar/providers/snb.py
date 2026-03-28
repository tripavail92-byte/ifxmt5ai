from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


@dataclass(frozen=True, slots=True)
class SNBReleaseMapping:
    event_code: str
    category: str
    country: str = "CH"
    currency: str = "CHF"
    region: str = "Europe"


DEFAULT_SNB_MAPPINGS: dict[str, SNBReleaseMapping] = {
    "SNB Interest Rate Decision": SNBReleaseMapping("SNB_RATE", "central_bank"),
    "Switzerland CPI": SNBReleaseMapping("CH_CPI", "inflation"),
    "Switzerland Manufacturing PMI": SNBReleaseMapping("CH_PMI_MFG", "growth"),
    "Switzerland Services PMI": SNBReleaseMapping("CH_PMI_SVC", "growth"),
}


class SNBProvider(EconomicCalendarProvider):
    """Swiss National Bank provider using a static schedule for 2026 demo."""

    name = "snb"

    def __init__(self, release_mappings: dict[str, SNBReleaseMapping] | None = None) -> None:
        self._release_mappings = release_mappings or DEFAULT_SNB_MAPPINGS
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
        country = mapping.country if mapping else "CH"
        currency = mapping.currency if mapping else "CHF"

        scheduled_at = datetime.fromisoformat(item["date"])
        impact = infer_impact(title=title, category=category, country=country, currency=currency)
        event_id = f"snb-{event_code.lower()}-{scheduled_at.date().isoformat()}"

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
            tags=("snb", category, currency.lower()),
            metadata={"source": "Swiss National Bank", "url": "https://www.snb.ch/"},
        )

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())

    def _build_static_schedule(self) -> list[dict[str, Any]]:
        """Switzerland next-week economic indicators."""
        return [
            {
                "date": "2026-03-31T10:00:00+00:00",
                "title": "Switzerland Manufacturing PMI",
                "description": "Final March 2026",
            },
        ]
