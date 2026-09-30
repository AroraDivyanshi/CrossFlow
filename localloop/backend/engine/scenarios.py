"""
Scenario simulator. A scenario is a dict of overrides passed to
build_instance(), so it actually changes the LP/MILP inputs and re-solves --
never a canned before/after pair.

Each scenario declares its natural capacity_mode:
  - outage / whole-network surge / build-or-retrofit scenarios use
    TOTAL_NETWORK (the question is "can the whole network, as it now stands
    or as proposed, cope with this total demand against nameplate capacity").
  - spare_capacity_demo uses INCREMENTAL_SPARE and supplies ONLY the
    incremental surge tonnage (generation_surge_fraction), never the full
    baseline -- see build_instance.build_instance's docstring for why mixing
    the two would double count the baseline waste.
run_scenario() lets a caller override capacity_mode, but defaults to the
scenario's own natural mode so a caller can't accidentally mix them.
"""
from .build_instance import build_instance
from .model import Field
from .optimizer import classify_decisions, solve

SCENARIOS = {
    "baseline": {
        "capacity_mode": "total_network",
        "overrides": {},
        "description": "Whole FY2025-26 network allocated against nameplate capacity. No scenario change.",
    },
    "ghazipur_outage": {
        "capacity_mode": "total_network",
        "overrides": {"facility_status": {"GHAZIPUR_WTE": "outage"}},
        "description": "Ghazipur WTE (1,300 TPD nameplate) taken offline; whole network re-optimized.",
    },
    "monsoon_surge_30pct": {
        "capacity_mode": "total_network",
        "overrides": {"generation_multiplier": {"MCD": 1.30, "NDMC": 1.30, "DCB": 1.30}},
        "description": "All three source nodes' generation scaled to 130% (monsoon disruption/surge), "
                        "re-optimized against nameplate capacity.",
    },
    "festival_surge_mcd_20pct": {
        "capacity_mode": "total_network",
        "overrides": {"generation_multiplier": {"MCD": 1.20}},
        "description": "MCD generation scaled to 120% (festival surge), re-optimized against nameplate capacity.",
    },
    "spare_capacity_demo": {
        "capacity_mode": "incremental_spare",
        "overrides": {"generation_surge_fraction": {"MCD": 0.05}},
        "description": "INCREMENTAL_SPARE: only a 5% MCD surge (on top of the already-assumed existing "
                        "load baked into each facility's spare-capacity calculation) is modelled as new "
                        "waste needing to be absorbed -- the 11,500 TPD MCD baseline itself is NOT "
                        "re-supplied as demand here.",
    },
}


def _strip_candidates(inst, budget_scenario: bool):
    if not budget_scenario:
        inst.facilities = {
            fid: f for fid, f in inst.facilities.items() if not f.is_candidate and f.status != "candidate"
        }
        for f in inst.facilities.values():
            f.retrofit_adds_tpd, f.retrofit_cost_annual = Field(), Field()
    return inst


def run_scenario(name: str, mode: str = "demo", capacity_mode: str | None = None, budget_scenario: bool = False):
    if name not in SCENARIOS:
        raise KeyError(f"unknown scenario {name!r}; choices: {list(SCENARIOS)}")
    spec = SCENARIOS[name]
    cap_mode = capacity_mode or spec["capacity_mode"]

    # INCREMENTAL_SPARE baseline MUST represent ZERO incremental supply, not the full city
    # baseline -- the whole point of this mode is "what changes if this extra tonnage shows
    # up", and that comparison is meaningless against a baseline that already re-supplies
    # the entire 11,862 TPD network as if it were new demand. Passing an EMPTY
    # generation_surge_fraction dict puts build_instance into incremental_mode with every
    # node resolving to 0 (see build_instance.py), which is exactly "0 TPD incremental waste".
    baseline_overrides = {"generation_surge_fraction": {}} if cap_mode == "incremental_spare" else {}

    baseline_inst = _strip_candidates(build_instance(mode=mode, overrides=baseline_overrides), budget_scenario)
    baseline_result = solve(baseline_inst, capacity_mode=cap_mode)

    inst = _strip_candidates(build_instance(mode=mode, overrides=spec["overrides"]), budget_scenario)
    result = solve(inst, capacity_mode=cap_mode)
    decisions = classify_decisions(result, baseline_result, inst.facilities)

    both_optimal = result.get("status") == "Optimal" and baseline_result.get("status") == "Optimal"
    return {
        "scenario": name,
        "scenario_description": spec["description"],
        "capacity_mode": cap_mode,
        "overrides_applied": spec["overrides"],
        "baseline": baseline_result,
        "result": result,
        "decisions": decisions,
        "instance": inst,  # kept for downstream engines (outputs/economics/explain) in this same run
        "diff": {
            "objective_delta_rs_per_year": (
                result["objective_rs_per_year"] - baseline_result["objective_rs_per_year"]
            ) if both_optimal else None,
            "landfill_delta_tpd": result.get("total_landfilled_tpd", 0) - baseline_result.get("total_landfilled_tpd", 0),
        },
    }
