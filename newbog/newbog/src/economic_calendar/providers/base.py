from __future__ import annotations

from abc import ABC, abstractmethod

from economic_calendar.models import EconomicEvent
from economic_calendar.schema import ProviderFetchRequest


class EconomicCalendarProvider(ABC):
    name: str

    @abstractmethod
    def fetch_events(self, request: ProviderFetchRequest) -> list[EconomicEvent]:
        raise NotImplementedError
