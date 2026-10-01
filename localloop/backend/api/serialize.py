"""
Shared serialization helper for the API layer.

run_pipeline()'s return value contains Field objects (engine.model.Field) and
dicts keyed by (node, facility) tuples -- neither is natively JSON-serializable.
This module converts both into the same shape run_demo.py already uses for its
JSON dumps, so the API's responses are byte-for-byte consistent with what the
backend's own CLI output produces. No business logic lives here -- this is a
pure data-shape conversion, nothing is computed or altered.
"""
import math

from engine.model import Field


def to_jsonable(obj):
    if isinstance(obj, dict):
        return {
            (f"{k[0]}->{k[1]}" if isinstance(k, tuple) else str(k)): to_jsonable(v)
            for k, v in obj.items()
        }
    if isinstance(obj, (list, tuple)) and not isinstance(obj, Field):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, Field):
        return obj.as_dict()
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None  # never emit non-finite JSON; null is the honest "no number" signal
        return obj
    if hasattr(obj, "__dict__") and not isinstance(obj, (str, int, bool, type(None))):
        # Defensive only -- a stray non-serializable object (e.g. an Instance) should never
        # reach a response; surfacing it as a visible string is safer than a 500 with no clue.
        return f"<UNSERIALIZED:{type(obj).__name__}>"
    return obj
