import unittest

from economic_calendar.models import EventImpact
from economic_calendar.rules.impact import infer_impact


class ImpactRulesTestCase(unittest.TestCase):
    def test_high_impact_keywords_are_detected(self) -> None:
        self.assertEqual(infer_impact("Consumer Price Index", "inflation", "US", "USD"), EventImpact.HIGH)
        self.assertEqual(infer_impact("Employment Situation", "labor", "US", "USD"), EventImpact.HIGH)

    def test_medium_impact_keywords_are_detected(self) -> None:
        self.assertEqual(infer_impact("Retail Sales", "consumption", "US", "USD"), EventImpact.MEDIUM)

    def test_low_impact_fallback_is_used(self) -> None:
        self.assertEqual(infer_impact("3-Month Bill Auction", "rates", "US", "USD"), EventImpact.LOW)


if __name__ == "__main__":
    unittest.main()
