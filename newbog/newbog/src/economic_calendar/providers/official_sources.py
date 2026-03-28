from __future__ import annotations

from economic_calendar.providers.base import EconomicCalendarProvider
from economic_calendar.providers.bls import BLSProvider
from economic_calendar.providers.boc import BOCProvider
from economic_calendar.providers.boj import BOJProvider
from economic_calendar.providers.ecb import ECBProvider
from economic_calendar.providers.fred import FredProvider
from economic_calendar.providers.ons import ONSProvider
from economic_calendar.providers.rba import RBAProvider
from economic_calendar.providers.rbnz import RBNZProvider
from economic_calendar.providers.snb import SNBProvider


class OfficialSourceRegistry:
    def __init__(
        self,
        fred_provider: FredProvider | None = None,
        bls_provider: BLSProvider | None = None,
        ecb_provider: ECBProvider | None = None,
        ons_provider: ONSProvider | None = None,
        boj_provider: BOJProvider | None = None,
        snb_provider: SNBProvider | None = None,
        rba_provider: RBAProvider | None = None,
        boc_provider: BOCProvider | None = None,
        rbnz_provider: RBNZProvider | None = None,
    ) -> None:
        self._providers: dict[str, EconomicCalendarProvider] = {
            "fred": fred_provider or FredProvider(),
            "bls": bls_provider or BLSProvider(),
            "ecb": ecb_provider or ECBProvider(),
            "ons": ons_provider or ONSProvider(),
            "boj": boj_provider or BOJProvider(),
            "snb": snb_provider or SNBProvider(),
            "rba": rba_provider or RBAProvider(),
            "boc": boc_provider or BOCProvider(),
            "rbnz": rbnz_provider or RBNZProvider(),
        }

    def register(self, provider: EconomicCalendarProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str) -> EconomicCalendarProvider:
        try:
            return self._providers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown provider: {name}") from exc

    def available(self) -> tuple[str, ...]:
        return tuple(sorted(self._providers))
