"""
Integrated LocalLoop backend pipeline.

DATA -> recipe (processing compatibility ADVISORY) -> optimizer (allocation,
via scenarios.run_scenario) -> output generation -> output-demand matching ->
economics/lifecycle impact -> structured Why explanation.

This is the single place that wires the seven pieces together into one
result. Every stage consumes the previous stage's actual output:
  - recipe runs on a feedstock profile (see DEFAULT_DEMO_FEEDSTOCK) and is
    ADVISORY ONLY -- see PIPELINE SEMANTICS below.
  - optimizer/scenario produces the real allocation.
  - outputs.match_outputs consumes that allocation's tonnes_allocated_tpd
    directly.
  - economics.compute_economics consumes both the allocation result AND the
    output-matching result.
  - explain.explain consumes the allocation result, baseline, and decisions
    from the SAME scenario run.

PIPELINE SEMANTICS -- recipe is advisory, not a feasibility constraint:
There is no compatibility matrix linking recipe_engine's scored methods to
which facility the optimizer is allowed to route waste to -- the optimizer's
allocation decisions in this MVP depend only on cost, capacity and status,
never on the recipe engine's compatibility scores. Calling recipe "advisory"
is therefore not a hedge -- it precisely describes the current integration:
useful, connected, run in the same pipeline, but NOT wired into optimizer
feasibility. RECIPE_INTEGRATION_STATUS below states this in the pipeline's
own output so nothing downstream (a UI, a report) can imply otherwise.
"""
from . import explain as explain_engine
from . import recipe as recipe_engine
from .economics import compute_economics
from .outputs import match_outputs
from .scenarios import SCENARIOS, run_scenario

RECIPE_INTEGRATION_STATUS = (
    "Processing compatibility advisory: the recipe engine's compatibility scores are informational only "
    "in this MVP. There is no compatibility matrix constraining the optimizer's allocation -- the "
    "optimizer chooses routes by cost, capacity and status alone. Treat the recipe stage's output as "
    "advice about what the waste stream is generally suited to, not as a feasibility filter the optimizer "
    "actually enforces."
)

# Feedstock profile used for the recipe-engine stage of the integrated demo.
# organic_fraction is a PROXY/ASSUMPTION, not a KNOWN or DERIVED official figure: it is a numeric
# stand-in loosely informed by the network snapshot's one real composition figure (Praja Foundation
# citing DPCC/MCD, Feb 2023: ~40% wet fraction of Delhi's MSW -- provenance.csv row P25), but "wet
# fraction" and "organic_fraction" are not the same measurement, and P25 is dated Feb 2023, not
# FY2025-26. It is kept as SUPPORTING EVIDENCE for why 0.40 was chosen, not as a claim that 0.40 IS a
# known/derived organic_fraction. moisture_pct, contamination_pct and cn_ratio have no supporting
# figure at all and are plain prototype assumptions.
DEFAULT_DEMO_FEEDSTOCK = {
    "organic_fraction": 0.40,  # ASSUMPTION/PROXY -- see DEFAULT_DEMO_FEEDSTOCK_NOTE
    "moisture_pct": 55,        # ASSUMPTION: typical mixed-MSW moisture placeholder, not measured
    "contamination_pct": 12,   # ASSUMPTION: typical mixed (non-source-segregated) MSW contamination placeholder
    "cn_ratio": 28,            # ASSUMPTION: mid-range placeholder within common organic-waste C/N literature
}
DEFAULT_DEMO_FEEDSTOCK_NOTE = (
    "ALL FOUR feedstock values are ASSUMPTIONS/PROXIES, not KNOWN or DERIVED official figures. "
    "organic_fraction (0.40) is a numeric stand-in loosely informed by a historical composition figure "
    "(Praja Foundation citing DPCC/MCD, ~40% wet fraction, Feb 2023 -- provenance.csv row P25), kept as "
    "SUPPORTING EVIDENCE only: 'wet fraction' is not the same measurement as 'organic_fraction', and P25 "
    "predates the FY2025-26 baseline. moisture_pct, contamination_pct and cn_ratio have no supporting "
    "figure at all and are plain prototype placeholders. None of these four values should be read as "
    "sourced Delhi feedstock data."
)


def run_pipeline(scenario_name: str = "baseline", mode: str = "demo", capacity_mode: str | None = None,
                  feedstock: dict | None = None, budget_scenario: bool = False) -> dict:
    """Runs the full seven-stage chain for one scenario and returns everything together."""
    feedstock = feedstock or DEFAULT_DEMO_FEEDSTOCK

    # 1. Recipe / processing compatibility -- ADVISORY ONLY, see RECIPE_INTEGRATION_STATUS.
    recipe_result = recipe_engine.evaluate(feedstock)

    # 2 & 3. Optimizer + scenario (BUILD/RETROFIT/REROUTE/DO_NOTHING, allocation)
    scenario_out = run_scenario(scenario_name, mode=mode, capacity_mode=capacity_mode, budget_scenario=budget_scenario)
    inst, result, baseline_result, decisions = (
        scenario_out["instance"], scenario_out["result"], scenario_out["baseline"], scenario_out["decisions"]
    )

    # 4 & 5. Output generation + output-demand matching, consuming THIS run's allocation
    output_match = None
    if result.get("status") == "Optimal" and mode == "demo":
        output_match = match_outputs(inst, result)

    # 6. Economics / lifecycle impact, consuming both the allocation and the output match
    economics_result = None
    if result.get("status") == "Optimal" and mode == "demo":
        economics_result = compute_economics(inst, result, output_match)

    # 7. Structured Why explanation, consuming the allocation, baseline and decisions
    explanation = None
    if result.get("status") == "Optimal":
        explanation = explain_engine.explain(inst, result, baseline_result, decisions)

    return {
        "scenario": scenario_name,
        "scenario_description": scenario_out["scenario_description"],
        "capacity_mode": scenario_out["capacity_mode"],
        "mode": mode,
        "feedstock_used": feedstock,
        "feedstock_note": DEFAULT_DEMO_FEEDSTOCK_NOTE if feedstock is DEFAULT_DEMO_FEEDSTOCK else None,
        "recipe": recipe_result,
        "recipe_integration_status": RECIPE_INTEGRATION_STATUS,
        "optimizer_result": result,
        "baseline_result": baseline_result,
        "decisions": decisions,
        "diff_vs_baseline": scenario_out["diff"],
        "output_matching": output_match,
        "economics": economics_result,
        "explanation": explanation,
    }
