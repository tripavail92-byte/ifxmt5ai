from __future__ import annotations

from datetime import UTC, datetime

from economic_calendar.models import EconomicEvent
from economic_calendar.providers.official_sources import OfficialSourceRegistry
from economic_calendar.rules.blocking import BlockDecision, should_block_trade
from economic_calendar.schema import ProviderFetchRequest


class EconomicCalendarEngine:
    def __init__(self, registry: OfficialSourceRegistry | None = None) -> None:
        self.registry = registry or OfficialSourceRegistry()

    def fetch(self, provider: str, start_utc: datetime, end_utc: datetime) -> list[EconomicEvent]:
        # Ensure start and end are timezone-aware (UTC)
        if start_utc.tzinfo is None:
            start_utc = start_utc.replace(tzinfo=UTC)
        if end_utc.tzinfo is None:
            end_utc = end_utc.replace(tzinfo=UTC)
        
        request = ProviderFetchRequest(start_utc=start_utc, end_utc=end_utc)
        events = self.registry.get(provider).fetch_events(request)
        return sorted(events, key=lambda event: event.scheduled_at_utc)

    def should_block(self, symbol: str, timestamp_utc: datetime, events: list[EconomicEvent]) -> BlockDecision:
        return should_block_trade(symbol=symbol, timestamp_utc=timestamp_utc, events=events)
