from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from economic_calendar.models import EconomicEvent, EventImpact


@dataclass(frozen=True, slots=True)
class BlockDecision:
    should_block: bool
    reason: str | None
    event: EconomicEvent | None
    minutes_to_event: int | None


DEFAULT_SYMBOL_CURRENCIES: dict[str, tuple[str, ...]] = {
    "EURUSD": ("EUR", "USD"),
    "GBPUSD": ("GBP", "USD"),
    "USDJPY": ("USD", "JPY"),
    "AUDUSD": ("AUD", "USD"),
    "NZDUSD": ("NZD", "USD"),
    "USDCAD": ("USD", "CAD"),
    "USDCHF": ("USD", "CHF"),
}


def should_block_trade(
    symbol: str,
    timestamp_utc: datetime,
    events: list[EconomicEvent],
    symbol_currencies: dict[str, tuple[str, ...]] | None = None,
) -> BlockDecision:
    relevant_currencies = (symbol_currencies or DEFAULT_SYMBOL_CURRENCIES).get(symbol.upper(), ())
    candidates = [event for event in events if event.currency in relevant_currencies]
    candidates.sort(key=lambda event: abs(int((event.scheduled_at_utc - timestamp_utc).total_seconds() // 60)))

    for event in candidates:
        minutes_to_event = int((event.scheduled_at_utc - timestamp_utc).total_seconds() // 60)
        if event.impact == EventImpact.HIGH and -15 <= minutes_to_event <= 15:
            return BlockDecision(True, f"High-impact {event.currency} event window", event, minutes_to_event)
        if event.impact == EventImpact.MEDIUM and -10 <= minutes_to_event <= 5:
            return BlockDecision(True, f"Medium-impact {event.currency} event window", event, minutes_to_event)

    return BlockDecision(False, None, None, None)
