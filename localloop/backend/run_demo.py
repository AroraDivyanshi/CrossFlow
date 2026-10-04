"""
Runnable entry point for DELHI_2025_26_DEMO_SCENARIO.

"Official FY2025-26 baseline with explicitly labelled prototype assumptions
for unavailable operational variables."

Run: python3 run_demo.py [scenario_name]
Scenarios: baseline, ghazipur_outage, monsoon_surge_30pct, festival_surge_mcd_20pct,
           spare_capacity_demo (INCREMENTAL_SPARE)

Each run exercises the full DATA -> recipe -> optimizer -> scenario -> outputs ->
output-demand matching -> economics -> explain chain via engine.pipeline.run_pipeline,
and writes a JSON dump to /mnt/user-data/outputs/.
"""
import json
import os
import sys

from engine.model import Field
from engine.pipeline import run_pipeline
from engine.scenarios import SCENARIOS

SCENARIO_LABEL = "DELHI_2025_26_DEMO_SCENARIO"
SCENARIO_DESCRIPTION = (
    "Official FY2025-26 baseline with explicitly labelled prototype assumptions "
    "for unavailable operational variables."
)


def _label(v):
    return {"KNOWN": "OBSERVED", "DERIVED": "DERIVED", "ASSUMPTION": "ASSUMED"}.get(v, v)


def render(name="baseline"):
    print(f"=== {SCENARIO_LABEL} :: {name} ===")
    print(SCENARIO_DESCRIPTION)
    out = run_pipeline(name)
    inst_facilities = out["optimizer_result"]

    print(f"\ncapacity_mode: {out['capacity_mode']}  |  {out['optimizer_result']['capacity_mode_note']}")
    print(f"scenario: {out['scenario_description']}")

    print("\n-- 1. Recipe / processing compatibility (feedstock stage) --")
    print(f"   feedstock: {out['feedstock_used']}  [{out['feedstock_note']}]")
    for m in out["recipe"]["ranked_by_compatibility"]:
        d = out["recipe"]["methods"][m]
        print(f"   {m:16} score={d['compatibility_score']:>5} category={d['category']:<12} "
              f"confidence={d['confidence']}")

    r = out["optimizer_result"]
    print("\n-- 2/3. Optimizer + scenario result --")
    print(f"   status: {r['status']}   objective: Rs {r['objective_rs_per_year']:,.0f}/year")
    print(f"   tonnes_allocated_tpd: {{{', '.join(f'{k}: {v:.1f}' for k, v in r['tonnes_allocated_tpd'].items())}}}")
    print(f"   landfilled_tpd: {r['landfilled_tpd']}   total: {r['total_landfilled_tpd']:.1f}")
    print(f"   built: {r['built']}   retrofitted: {r['retrofitted']}")
    print(f"   decisions: {out['decisions']}")
    print(f"   diff vs baseline: {out['diff_vs_baseline']}")
    print(f"   caveats: {r['caveats']}")

    if out["output_matching"]:
        print("\n-- 4/5. Output generation + demand matching --")
        for otype, d in out["output_matching"]["by_output_type"].items():
            print(f"   {otype}: supply={d['total_supply_per_day']:.1f}/day  "
                  f"matched={d['total_matched_per_day']:.1f}  "
                  f"utilization={d['utilization_of_recovered_output_pct']}%  "
                  f"demand_fulfilment={d['demand_fulfilment_pct']}%  "
                  f"unmet={d['unmet_by_demand']}")

    if out["economics"]:
        e = out["economics"]
        print("\n-- 6. Economics / lifecycle impact --")
        print(f"   financial_cost: Rs {e['costs_rs_per_year']['financial_cost_rs_per_year']['value']:,.0f} "
              f"[{e['costs_rs_per_year']['financial_cost_rs_per_year']['label']}]")
        print(f"   cost_per_tonne: Rs {e['costs_rs_per_year']['cost_per_tonne']['value']:,.1f} "
              f"[{e['costs_rs_per_year']['cost_per_tonne']['label']}]")
        print(f"   recovered_resource_value: Rs {e['recovered_resource_value_rs_per_year']['value']:,.0f} "
              f"[{e['recovered_resource_value_rs_per_year']['label']}]")
        print(f"   net_annual_cost_after_recovery: Rs {e['net_annual_cost_after_recovery_rs']['value']:,.0f}")
        print(f"   landfill_diversion_pct: {e['landfill_diversion_pct']['value']:.1f}% "
              f"[{e['landfill_diversion_pct']['label']}]")
        imp = e["lifecycle_impact_tco2e_per_year"]
        print(f"   avoided_emissions: {imp['avoided_emissions']['value']:,.0f} tCO2e/year [MODELLED]")
        print(f"   caveat: {e['caveat'][:120]}...")

    if out["explanation"]:
        print("\n-- 7. Structured Why explanation (facility decisions) --")
        for fid, info in out["explanation"]["facility_decisions"].items():
            print(f"   {fid:26} {info['decision']:10} {info['reasons'][-1][:110]}")

    return out


if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "baseline"
    out = render(name)

    def stringify(o):
        if isinstance(o, dict):
            return {(f"{k[0]}->{k[1]}" if isinstance(k, tuple) else str(k)): stringify(v) for k, v in o.items()}
        if isinstance(o, list):
            return [stringify(v) for v in o]
        if isinstance(o, tuple):
            return list(o)
        if isinstance(o, Field):
            return o.as_dict()
        if hasattr(o, "__dict__") and not isinstance(o, (str, int, float, bool, type(None))):
            return f"<{type(o).__name__} object, not serialised>"
        return o

    out_clean = {k: v for k, v in out.items()}
    # Output dir: $CROSSFLOW_OUTPUT_DIR, else /mnt/user-data/outputs if it exists, else the current directory.
    out_dir = os.environ.get("CROSSFLOW_OUTPUT_DIR") or (
        "/mnt/user-data/outputs" if os.path.isdir("/mnt/user-data/outputs") else ".")
    out_path = os.path.join(out_dir, f"localloop_pipeline_{name}_output.json")
    with open(out_path, "w") as f:
        json.dump(stringify(out_clean), f, indent=2, default=str)
    print(f"\n[written {out_path}]")