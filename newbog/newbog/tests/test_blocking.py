import unittest
from datetime import UTC, datetime

from economic_calendar.models import EconomicEvent, EventImpact
from economic_calendar.rules.blocking import should_block_trade


def make_event(title: str, currency: str, impact: EventImpact, at_iso: str) -> EconomicEvent:
    return EconomicEvent(
        id=f"evt-{title}",
        source="official",
        source_event_id=None,
        provider="fred",
        country="US",
        currency=currency,
        category="macro",
        title=title,
        event_code=title.upper().replace(" ", "_"),
        scheduled_at_utc=datetime.fromisoformat(at_iso).astimezone(UTC),
        impact=impact,
    )


class BlockingRulesTestCase(unittest.TestCase):
    def test_high_impact_event_blocks_trade(self) -> None:
        events = [make_event("CPI", "USD", EventImpact.HIGH, "2026-03-15T12:30:00+00:00")]
        decision = should_block_trade("EURUSD", datetime.fromisoformat("2026-03-15T12:25:00+00:00"), events)
        self.assertTrue(decision.should_block)

    def test_irrelevant_currency_does_not_block_trade(self) -> None:
        events = [make_event("CPI", "JPY", EventImpact.HIGH, "2026-03-15T12:30:00+00:00")]
        decision = should_block_trade("EURUSD", datetime.fromisoformat("2026-03-15T12:25:00+00:00"), events)
        self.assertFalse(decision.should_block)


if __name__ == "__main__":
    unittest.main()
