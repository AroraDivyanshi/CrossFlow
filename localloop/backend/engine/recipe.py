"""
Waste Recipe Engine -- transparent, rule-based (no ML) compatibility scoring
between a feedstock profile and processing methods, with all thresholds
loaded from data_pack/recipe_thresholds.json so they are auditable.

Feedstock profile fields (any may be omitted -- omitted factors are simply
not scored):
  organic_fraction         (0-1)
  moisture_pct             (0-100)
  contamination_pct        (0-100)  -- inert/plastic/non-compostable share
  cn_ratio                 (e.g. 25 for 25:1)
  dry_combustible_fraction (0-1)    -- ONLY if independently measured (lab
                                        proximate analysis / calorimetry).
                                        If omitted, WTE/RDF derive a DIAGNOSTIC
                                        estimate from moisture_pct, but that
                                        estimate is never scored as a second
                                        independent factor -- see below.

IMPORTANT -- moisture / dry-combustible-fraction, no double counting:
For waste_to_energy and rdf, moisture_pct is the ONE independently supplied,
scored factor. A moisture-derived dry_combustible_fraction (1 - moisture/100)
is the SAME underlying measurement re-expressed, so it is computed and
reported as a diagnostic value only -- it is excluded from compatibility_score,
from the evaluated/total factor counts, and from confidence. It contributes to
score/confidence ONLY when the caller supplies dry_combustible_fraction
directly in the feedstock dict, i.e. an independently measured figure that did
not come from this engine's own moisture-based estimate.

Confidence: a score computed from only 1 of a method's factors is not
presented with the same weight as one computed from all of them, and a
moisture-derived diagnostic never inflates that count. Confidence is reported
separately (fraction_evaluated -> LOW/MEDIUM/HIGH per recipe_thresholds.json's
confidence_bands) using only genuinely independent evaluated inputs.
"""
import json
from pathlib import Path

THRESHOLDS_FILE = Path(__file__).resolve().parents[3] / "data_pack" / "recipe_thresholds.json"
METHODS = ("composting", "biomethanation", "waste_to_energy", "rdf")

_DIAGNOSTIC_NOTE = (
    "dry_combustible_fraction was not independently supplied, so a DIAGNOSTIC estimate was computed as "
    "(1 - moisture_pct/100). This is the SAME underlying measurement as the moisture_pct factor already "
    "scored above -- it is shown for reference only and is NOT counted as a second independent factor in "
    "the compatibility score or confidence. Supply an independently measured dry_combustible_fraction "
    "(e.g. from proximate analysis) to have it scored as its own factor."
)


def load_thresholds():
    return json.load(open(THRESHOLDS_FILE))


def _range_score(value, lo, hi):
    if value is None:
        return None
    if lo <= value <= hi:
        return 1.0
    width = max(hi - lo, 1e-6)
    dist = (lo - value) if value < lo else (value - hi)
    return max(0.0, 1.0 - dist / (2 * width))


def _min_score(value, minimum):
    if value is None:
        return None
    if value >= minimum:
        return 1.0
    return max(0.0, value / minimum)


def _max_score(value, maximum):
    if value is None:
        return None
    if value <= maximum:
        return 1.0
    excess = value - maximum
    return max(0.0, 1.0 - excess / max(maximum, 1e-6))


def _categorise(score, bands):
    if score is None:
        return "INSUFFICIENT_DATA"
    if score >= bands["compatible_min"]:
        return "Compatible"
    if score >= bands["marginal_min"]:
        return "Marginal"
    return "Incompatible"


def _confidence(n_evaluated, n_total, bands):
    if n_total == 0:
        return "NONE"
    frac = n_evaluated / n_total
    cb = bands["confidence_bands"]
    if frac >= cb["high_min_fraction_evaluated"]:
        return "HIGH"
    if frac >= cb["medium_min_fraction_evaluated"]:
        return "MEDIUM"
    if frac > 0:
        return "LOW"
    return "NONE"


def _evaluate_method(method, t, feedstock):
    """Returns scored (independent) factors separately from diagnostic-only values.
    dry_combustible_fraction only enters `factors` (and therefore score/confidence) when
    the caller supplied it directly -- never when this function derives it from moisture."""
    factors, diagnostics = {}, {}
    if method in ("composting", "biomethanation"):
        factors["organic_fraction"] = _min_score(feedstock.get("organic_fraction"), t["min_organic_fraction"])
        factors["moisture_pct"] = _range_score(feedstock.get("moisture_pct"), *t["moisture_range_pct"])
        factors["cn_ratio"] = _range_score(feedstock.get("cn_ratio"), *t["cn_ratio_range"])
        factors["contamination_pct"] = _max_score(feedstock.get("contamination_pct"), t["max_contamination_pct"])

    elif method in ("waste_to_energy", "rdf"):
        factors["moisture_pct"] = _max_score(feedstock.get("moisture_pct"), t["max_moisture_pct"])
        independent_dcf = feedstock.get("dry_combustible_fraction")
        if independent_dcf is not None:
            # genuinely independent measurement -- scored as its own factor
            factors["dry_combustible_fraction"] = _min_score(independent_dcf, t["min_dry_combustible_fraction"])
        elif feedstock.get("moisture_pct") is not None:
            # diagnostic only -- derived from the SAME moisture_pct already scored above;
            # deliberately kept OUT of `factors` so it cannot inflate score or confidence
            proxy_value = max(0.0, 1 - feedstock["moisture_pct"] / 100.0)
            diagnostics["dry_combustible_fraction_estimated_from_moisture"] = {
                "value": round(proxy_value, 3),
                "diagnostic_score_not_counted": _min_score(proxy_value, t["min_dry_combustible_fraction"]),
                "note": "Derived from moisture_pct (1 - moisture/100); same underlying measurement as the "
                        "moisture_pct factor above -- excluded from score/confidence.",
            }

    total = len(factors)
    evaluated = {k: v for k, v in factors.items() if v is not None}
    unevaluated = [k for k, v in factors.items() if v is None]
    score = round(100 * sum(evaluated.values()) / len(evaluated), 1) if evaluated else None
    limiting = [k for k, v in evaluated.items() if v < 0.7]
    return {
        "score": score, "total_factors": total, "evaluated_factors": len(evaluated),
        "unevaluated_factors": unevaluated, "limiting_factors": limiting,
        "raw_factor_scores": evaluated, "diagnostics": diagnostics,
    }


def _recommend_adjustment(method, t, feedstock, limiting):
    tips = []
    if "moisture_pct" in limiting:
        m = feedstock.get("moisture_pct")
        if method in ("waste_to_energy", "rdf"):
            maxm = t["max_moisture_pct"]
            tips.append(f"moisture ({m}%) exceeds the {maxm}% ceiling assumed for {method}; "
                        f"blend with drier waste or pre-dry before feeding")
        else:
            lo, hi = t["moisture_range_pct"]
            tips.append(f"moisture ({m}%) is outside the {lo}-{hi}% range assumed for {method}; "
                        f"adjust by blending wetter/drier feedstock")
    if "cn_ratio" in limiting:
        c = feedstock.get("cn_ratio")
        lo, hi = t["cn_ratio_range"]
        tips.append(f"C/N ratio ({c}) is outside the {lo}-{hi} range assumed for {method}; "
                     f"add carbon-rich dry material (e.g. dry leaves/paper) if too low, "
                     f"or nitrogen-rich wet material if too high")
    if "organic_fraction" in limiting:
        mn = t.get("min_organic_fraction")
        tips.append(f"organic fraction is below the {mn} threshold assumed for {method}; "
                     f"improve source segregation or blend with a higher-organic input stream")
    if "contamination_pct" in limiting:
        mx = t.get("max_contamination_pct")
        tips.append(f"contamination exceeds the {mx}% tolerance assumed for {method}; "
                     f"add or improve a pre-sorting/screening step before this method")
    if "dry_combustible_fraction" in limiting:
        # only reachable when dry_combustible_fraction was an INDEPENDENTLY supplied factor
        mn = t.get("min_dry_combustible_fraction")
        tips.append(f"independently measured dry combustible fraction is below the {mn} threshold "
                     f"assumed for {method}; reduce moisture or blend with drier waste")
    return tips


def evaluate(feedstock: dict) -> dict:
    """feedstock: dict with any of organic_fraction, moisture_pct, contamination_pct, cn_ratio,
    and optionally an independently measured dry_combustible_fraction."""
    t = load_thresholds()
    bands = t["scoring"]
    results = {}
    for method in METHODS:
        ev = _evaluate_method(method, t[method], feedstock)
        category = _categorise(ev["score"], bands)
        confidence = _confidence(ev["evaluated_factors"], ev["total_factors"], bands)
        explanation = (
            f"Scored on {list(ev['raw_factor_scores'])} of {ev['total_factors']} independent factors "
            f"against thresholds in recipe_thresholds.json ({t[method]['evidence'][:100]}...)."
            if ev["raw_factor_scores"] else "No independently scoreable factors were provided for this method."
        )
        if ev["diagnostics"]:
            explanation += " " + _DIAGNOSTIC_NOTE
        results[method] = {
            "compatibility_score": ev["score"],
            "category": category,
            "confidence": confidence,
            "factors_evaluated": f"{ev['evaluated_factors']}/{ev['total_factors']} (independent factors only)",
            "limiting_factors": ev["limiting_factors"],
            "unevaluated_factors": ev["unevaluated_factors"],
            "diagnostics": ev["diagnostics"],
            "recommended_adjustment": _recommend_adjustment(method, t[method], feedstock, ev["limiting_factors"]),
            "explanation": explanation,
        }
    ranked = sorted(
        [m for m in METHODS if results[m]["compatibility_score"] is not None],
        key=lambda m: (-results[m]["compatibility_score"], results[m]["confidence"] != "HIGH"),
    )
    return {
        "feedstock": feedstock,
        "methods": results,
        "ranked_by_compatibility": ranked,
        "note": "A high score with LOW/MEDIUM confidence means the method looks promising on the "
                "independent factors supplied, but others are unknown -- supply more of the feedstock "
                "profile before treating the ranking as reliable. Diagnostic values (e.g. a "
                "moisture-derived dry_combustible_fraction) never raise a score or confidence band.",
    }
