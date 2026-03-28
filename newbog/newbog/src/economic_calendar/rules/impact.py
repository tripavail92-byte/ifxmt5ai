from __future__ import annotations

from economic_calendar.models import EventImpact


HIGH_PRIORITY_KEYWORDS = (
    "consumer price index",
    "cpi",
    "employment situation",
    "nonfarm",
    "fomc",
    "gross domestic product",
    "gdp",
    "interest rate",
    "policy decision",
    "pce",
    "pmi",
    "manufacturing pmi",
    "services pmi",
)

MEDIUM_PRIORITY_KEYWORDS = (
    "retail sales",
    "producer price index",
    "ppi",
    "unemployment",
    "initial claims",
    "durable goods",
    "consumer sentiment",
    "industrial production",
)


def infer_impact(title: str, category: str, country: str, currency: str) -> EventImpact:
    normalized = f"{title} {category} {country} {currency}".lower()
    if any(keyword in normalized for keyword in HIGH_PRIORITY_KEYWORDS):
        return EventImpact.HIGH
    if any(keyword in normalized for keyword in MEDIUM_PRIORITY_KEYWORDS):
        return EventImpact.MEDIUM
    if category in {"labor", "inflation", "growth", "central_bank", "consumption"}:
        return EventImpact.MEDIUM
    return EventImpact.LOW
