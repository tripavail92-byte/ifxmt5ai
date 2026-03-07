# AI Sensitivity module plan (mt5system)

## Goal
Create a single, reusable module in `C:\mt5system` that:
- Reads `AI_SENSITIVITY` from environment variables (default `5`).
- Clamps the knob to a safe range.
- Applies sensitivity scaling to window/size parameters (e.g., structure detection sizes).

This is intentionally **separate from** the reference folder `code for choch nbos/` (which will be deleted).

## Definitions
- **Baseline**: `AI_SENSITIVITY = 5` → no scaling.
- **Scaling factor**: `factor = AI_SENSITIVITY / 5`.
  - `AI_SENSITIVITY < 5` → smaller windows → more sensitive.
  - `AI_SENSITIVITY > 5` → larger windows → less sensitive.

## Deliverables (this folder)
- `ai_sensitivity/config.py`
  - `AISensitivityConfig.from_env()` reads + clamps.
- `ai_sensitivity/sizer.py`
  - `apply_ai_sensitivity_to_sizes()` scales `(internal_size, swing_size)`.
  - Guardrails clamp returned sizes to a safe min/max.

## Integration points (next step when you say "wire it in")
Pick the place(s) in `C:\mt5system` that currently compute any window sizes, and replace direct constants with:
1) define base sizes (your existing values)
2) compute scaled sizes using this module
3) log: base sizes, `AI_SENSITIVITY`, scaled sizes

Likely candidates to review:
- `ai_engine/` (if it has any size/window parameters)
- any realtime processor/poller logic that does pattern detection

## Validation
- With `AI_SENSITIVITY` unset → sizes unchanged.
- With `AI_SENSITIVITY=3` → sizes reduce by ~40%.
- With `AI_SENSITIVITY=10` → sizes increase by ~2x.
- Out-of-range values clamp (e.g., `0` → `1`, `999` → `20`).
