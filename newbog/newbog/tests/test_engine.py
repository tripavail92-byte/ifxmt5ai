import unittest
from datetime import UTC, datetime

from economic_calendar.engine import EconomicCalendarEngine
from economic_calendar.models import EconomicEvent, EventImpact
from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.providers.official_sources import OfficialSourceRegistry
from economic_calendar.schema import ProviderFetchRequest


class StaticProvider(EconomicCalendarProvider):
    name = "static"

    def fetch_events(self, request: ProviderFetchRequest) -> list[EconomicEvent]:
        return [
            EconomicEvent(
                id="1",
                source="official",
                source_event_id="1",
                provider="static",
                country="US",
                currency="USD",
                category="inflation",
                title="Consumer Price Index",
                event_code="CPI",
                scheduled_at_utc=datetime(2026, 3, 15, 12, 30, tzinfo=UTC),
                impact=EventImpact.HIGH,
            )
        ]


class EngineTestCase(unittest.TestCase):
    def test_engine_fetch_and_blocking(self) -> None:
        registry = OfficialSourceRegistry()
        registry.register(StaticProvider())
        engine = EconomicCalendarEngine(registry)
        events = engine.fetch("static", datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 3, 31, tzinfo=UTC))
        self.assertEqual(len(events), 1)
        decision = engine.should_block("EURUSD", datetime(2026, 3, 15, 12, 25, tzinfo=UTC), events)
        self.assertTrue(decision.should_block)


if __name__ == "__main__":
    unittest.main()