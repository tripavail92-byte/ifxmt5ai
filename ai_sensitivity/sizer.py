from __future__ import annotations

from dataclasses import dataclass


def clamp_ai_sensitivity(value: int, *, min_value: int = 1, max_value: int = 10) -> int:
    if value < min_value:
        return min_value
    if value > max_value:
        return max_value
    return value


def _clamp_size(value: int, *, min_value: int = 2, max_value: int = 500) -> int:
    if value < min_value:
        return min_value
    if value > max_value:
        return max_value
    return value


def apply_ai_sensitivity_to_sizes(
    *,
    base_internal_size: int,
    base_swing_size: int,
    ai_sensitivity: int,
    baseline: int = 5,
) -> tuple[int, int]:
    """Scale (internal, swing) sizes based on an integer sensitivity knob.

    Scaling factor is `ai_sensitivity / baseline`.

    Notes:
    - We round to nearest int.
    - We clamp to guardrail bounds so callers can't accidentally create
      nonsensical windows.
    """

    ai_sensitivity = clamp_ai_sensitivity(ai_sensitivity)

    if baseline <= 0:
        baseline = 5

    factor = ai_sensitivity / float(baseline)

    internal_size = int(round(base_internal_size * factor))
    swing_size = int(round(base_swing_size * factor))

    return _clamp_size(internal_size), _clamp_size(swing_size)


@dataclass(frozen=True)
class StructureSizes:
    internal_size: int
    swing_size: int

    @staticmethod
    def from_base(
        *,
        base_internal_size: int,
        base_swing_size: int,
        ai_sensitivity: int,
    ) -> "StructureSizes":
        internal_size, swing_size = apply_ai_sensitivity_to_sizes(
            base_internal_size=base_internal_size,
            base_swing_size=base_swing_size,
            ai_sensitivity=ai_sensitivity,
        )
        return StructureSizes(internal_size=internal_size, swing_size=swing_size)
