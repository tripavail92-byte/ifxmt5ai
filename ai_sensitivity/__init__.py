"""AI sensitivity module.

This module centralizes the "AI_SENSITIVITY" knob so other parts of the
system can scale detection/window sizes consistently.
"""

from .config import AISensitivityConfig
from .sizer import apply_ai_sensitivity_to_sizes, clamp_ai_sensitivity

__all__ = [
    "AISensitivityConfig",
    "apply_ai_sensitivity_to_sizes",
    "clamp_ai_sensitivity",
]
