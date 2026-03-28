import unittest
from datetime import UTC, datetime

from economic_calendar.providers.fred import FredProvider
from economic_calendar.schema import ProviderFetchRequest


class StubFredProvider(FredProvider):
    def _get_release_dates(self, request: ProviderFetchRequest) -> list[dict[str, object]]:
        return [
            {
                "release_id": 10,
                "release_name": "Consumer Price Index",
                "date": "2026-03-15",
                "release_last_updated": "2026-03-01",
            },
            {
                "release_id": 20,
                "release_name": "3-Month Bill Auction",
                "date": "2026-03-16",
                "release_last_updated": "2026-03-01",
            },
        ]


class FredProviderTestCase(unittest.TestCase):
    def test_fred_provider_normalizes_release_dates(self) -> None:
        provider = StubFredProvider()
        request = ProviderFetchRequest(
            start_utc=datetime(2026, 3, 1, tzinfo=UTC),
            end_utc=datetime(2026, 3, 31, tzinfo=UTC),
        )
        events = provider.fetch_events(request)

        self.assertEqual(len(events), 2)
        self.assertEqual(events[0].currency, "USD")
        self.assertEqual(events[0].event_code, "CPI")
        self.assertEqual(events[0].impact.value, "high")
        self.assertEqual(events[1].impact.value, "low")


if __name__ == "__main__":
    unittest.main()
