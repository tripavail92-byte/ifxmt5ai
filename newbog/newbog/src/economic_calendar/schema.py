from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class ProviderFetchRequest:
    start_utc: datetime
    end_utc: datetime


@dataclass(frozen=True, slots=True)
class TradeContext:
    symbol: str
    timestamp_utc: datetime
