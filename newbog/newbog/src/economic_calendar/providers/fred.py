from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from economic_calendar.models import EconomicEvent, EventImpact, EventStatus
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.rules.impact import infer_impact
from economic_calendar.schema import ProviderFetchRequest


FRED_BASE_URL = "https://api.stlouisfed.org/fred"


@dataclass(frozen=True, slots=True)
class FredReleaseMapping:
    event_code: str
    country: str
    currency: str
    category: str
    region: str


DEFAULT_RELEASE_MAPPINGS: dict[str, FredReleaseMapping] = {
    "Consumer Price Index": FredReleaseMapping("CPI", "US", "USD", "inflation", "North America"),
    "Employment Situation": FredReleaseMapping("NFP", "US", "USD", "labor", "North America"),
    "Gross Domestic Product": FredReleaseMapping("GDP", "US", "USD", "growth", "North America"),
    "Advance Monthly Sales for Retail and Food Services": FredReleaseMapping("RETAIL_SALES", "US", "USD", "consumption", "North America"),
    "Unemployment Rate": FredReleaseMapping("UNEMPLOYMENT", "US", "USD", "labor", "North America"),
    "Initial Claims": FredReleaseMapping("INITIAL_CLAIMS", "US", "USD", "labor", "North America"),
    "Federal Open Market Committee": FredReleaseMapping("FOMC", "US", "USD", "central_bank", "North America"),
    "Producer Price Index": FredReleaseMapping("PPI", "US", "USD", "inflation", "North America"),
    "Personal Income and Outlays": FredReleaseMapping("PCE", "US", "USD", "inflation", "North America"),
}


class FredProvider(EconomicCalendarProvider):
    name = "fred"

    def __init__(self, api_key: str | None = None, release_mappings: dict[str, FredReleaseMapping] | None = None) -> None:
        self._api_key = api_key or os.getenv("FRED_API_KEY")
        self._release_mappings = release_mappings or DEFAULT_RELEASE_MAPPINGS

    def fetch_events(self, request: ProviderFetchRequest) -> list[EconomicEvent]:
        release_dates = self._get_release_dates(request)
        return [self._normalize_release(item) for item in release_dates]

    def _get_release_dates(self, request: ProviderFetchRequest) -> list[dict[str, Any]]:
        params = {
            "file_type": "json",
            "realtime_start": request.start_utc.date().isoformat(),
            "realtime_end": request.end_utc.date().isoformat(),
            "include_release_dates_with_no_data": "true",
        }
        if self._api_key:
            params["api_key"] = self._api_key
        payload = self._request_json("releases/dates", params)
        return payload.get("release_dates", [])

    def _normalize_release(self, item: dict[str, Any]) -> EconomicEvent:
        release_name = item["release_name"]
        mapping = self._release_mappings.get(release_name)
        scheduled_at = self._parse_release_datetime(item["date"])
        event_code = mapping.event_code if mapping else self._slugify(release_name).upper()
        country = mapping.country if mapping else "US"
        currency = mapping.currency if mapping else "USD"
        category = mapping.category if mapping else "macro"
        region = mapping.region if mapping else "North America"
        impact = infer_impact(title=release_name, category=category, country=country, currency=currency)
        event_id = f"fred-{event_code.lower()}-{scheduled_at.date().isoformat()}"
        return EconomicEvent(
            id=event_id,
            source="official",
            source_event_id=str(item.get("release_id")),
            provider=self.name,
            country=country,
            currency=currency,
            category=category,
            title=release_name,
            event_code=event_code,
            scheduled_at_utc=scheduled_at,
            impact=impact,
            status=EventStatus.SCHEDULED,
            unit=None,
            region=region,
            tags=("fred", category, currency.lower()),
            metadata={
                "release_id": item.get("release_id"),
                "release_last_updated": item.get("release_last_updated"),
            },
        )

    def _request_json(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        query = urllib.parse.urlencode(params)
        url = f"{FRED_BASE_URL}/{path}?{query}"
        with urllib.request.urlopen(url, timeout=20) as response:
            data = response.read().decode("utf-8")
        return json.loads(data)

    @staticmethod
    def _parse_release_datetime(date_str: str) -> datetime:
        return datetime.fromisoformat(f"{date_str}T00:00:00+00:00").astimezone(UTC)

    @staticmethod
    def _slugify(value: str) -> str:
        return "_".join(part for part in "".join(ch if ch.isalnum() else " " for ch in value).split())
