from __future__ import annotations

import os
from dataclasses import dataclass

from .sizer import clamp_ai_sensitivity


@dataclass(frozen=True)
class AISensitivityConfig:
    """Environment-driven configuration for AI sensitivity.

    `AI_SENSITIVITY` is treated as an integer knob where:
      - 5 is the baseline (no change)
      - <5 makes sizes smaller (more sensitive)
      - >5 makes sizes larger (less sensitive)

    The config is clamped to a safe range (1–10) to avoid extreme values.
    """

    ai_sensitivity: int = 5

    @staticmethod
    def from_env() -> "AISensitivityConfig":
        raw = (os.getenv("AI_SENSITIVITY") or "").strip()
        if not raw:
            return AISensitivityConfig(ai_sensitivity=5)

        try:
            value = int(raw)
        except ValueError:
            value = 5

        return AISensitivityConfig(ai_sensitivity=clamp_ai_sensitivity(value))
