from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class EventImpact(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    UNKNOWN = "unknown"


class EventStatus(StrEnum):
    SCHEDULED = "scheduled"
    RELEASED = "released"
    REVISED = "revised"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


@dataclass(slots=True)
class EconomicEvent:
    id: str
    source: str
    source_event_id: str | None
    provider: str
    country: str
    currency: str
    category: str
    title: str
    event_code: str
    scheduled_at_utc: datetime
    impact: EventImpact
    status: EventStatus = EventStatus.SCHEDULED
    actual: float | str | None = None
    forecast: float | str | None = None
    previous: float | str | None = None
    unit: str | None = None
    region: str | None = None
    tags: tuple[str, ...] = field(default_factory=tuple)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["scheduled_at_utc"] = self.scheduled_at_utc.isoformat()
        payload["impact"] = self.impact.value
        payload["status"] = self.status.value
        return payload
