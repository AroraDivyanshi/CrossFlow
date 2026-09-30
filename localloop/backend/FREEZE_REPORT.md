# CrossFlow Backend — Freeze Check Report

This is a **freeze check**, not a redesign. No architecture, formulas, scope, or
assumptions were changed except where a genuine bug was found and fixed (see
BLOCKERS below). The backend is **APPROVED and FROZEN** for frontend development.

## 1. Test results

| Suite | Tests | Passed | Failed |
|---|---|---|---|
| `tests/test_optimizer.py` | 24 | 24 | 0 |
| `tests/test_engines.py` | 33 | 33 | 0 |
| **Total** | **57** | **57** | **0** |

Run with: `python3 -m tests.test_optimizer` / `python3 -m tests.test_engines`
(pytest is not installable in the build environment — no outbound network — so
both files run standalone via a small pytest-free assertion shim; this is
unchanged from earlier passes and is not a blocker).

## 2. BLOCKERS found and fixed during this check

**One genuine blocker**, found while re-verifying the `financial_cost_rs_per_year`
vs `optimizer_objective_rs_per_year` separation added in the prior correction pass:

- **Incorrect note text, not incorrect numbers.** The code correctly computed
  `financial_cost_rs_per_year` (excludes environmental externality pricing) and
  `optimizer_objective_rs_per_year` (includes it) as two different numbers. But
  the explanatory note attached to both fields incorrectly claimed *"when all
  weights are 1.0, the two coincide numerically."* Running the baseline scenario
  showed they do **not** coincide even at default weights (objective:
  Rs 9.75B/yr vs financial cost: Rs 5.55B/yr) — because `landfill_env`
  (an ASSUMED nonzero environmental cost) is included in the objective and
  correctly excluded from financial cost, regardless of weight values. **Fixed**
  in both `optimizer.py`'s `objective_rs_per_year_note` and `economics.py`'s
  `financial_vs_objective_note` — they now state the real reason the two differ
  (environmental externality pricing) and report the actual observed gap each
  run, rather than a wrong claim about when they'd match.

Also found: **4 stale test assertions** left over from the previous correction
pass, referencing field names/shapes that were correctly renamed in that pass
but never re-tested (`total_annual_cost` → `financial_cost_rs_per_year`,
`compost_processing_emissions` moved out of the main lifecycle total,
`proxies_used` → `diagnostics`, and the `factors_evaluated` string format).
These were test bugs, not backend bugs — the backend behavior was already
correct; the tests just hadn't been updated to check it. Fixed and re-run
(2 new tests added alongside the fixes to directly cover the financial-vs-objective
gap and the compost-is-auxiliary invariant).

No other blockers found. Specifically verified with zero issues:
- Broken imports: none (`python3 -c "from engine.pipeline import run_pipeline"` succeeds).
- Missing/renamed fields between modules: none found beyond the note-text issue above.
- API response mismatches: full pipeline output for all 5 scenarios serializes
  to valid JSON with no unserialized objects, no NaN/Infinity, no leaked
  `Instance`/`Field` objects (see §4 for the exact contract).
- TPD/year unit mistakes: `DAYS_PER_YEAR` (365) is the single constant used
  everywhere a per-day figure is annualized; verified via
  `test_objective_annual_unit_consistency_*` and `test_economics_annual_basis_matches_optimizer_days_per_year`.
- Runtime errors: none across all 5 scenarios, run with warnings-as-errors (`-W error`).
- VALIDATED/DEMO leakage: confirmed `run_pipeline(..., mode="validated")` fails
  honestly at the optimizer stage (`MissingDataError`) and never reaches
  outputs/economics — no demo assumption ever appears in a validated-mode result.
- Optimizer/economics contract mismatch: `economics.compute_economics` reads
  `tonnes_allocated_tpd`, `flows_tpd`, `landfilled_tpd`, `total_landfilled_tpd`,
  `built`, `retrofitted`, `objective_rs_per_year` — all present and correctly
  shaped in every optimizer result checked.
- Frontend-critical null/missing-data issues: none — `economics` and
  `output_matching` are `None` only when `optimizer_result.status != "Optimal"`
  or `mode != "demo"`, both flaggable by the frontend from `optimizer_result.status`
  and `mode` before reading further.

I also directly re-verified three correctness items from the prior pass that
had no test coverage yet (not new development — confirming already-implemented
behavior): `_prefer()` correctly lets a KNOWN network value override a DEMO
assumption; facility `env_cost` is `ASSUMPTION` (demo) / `UNKNOWN` (validated),
never a silent `KNOWN 0.0`; and a source/demand pair with missing coordinates
in `outputs.py` is made *ineligible* (bounded to 0 in the LP), not given a
free zero-cost route. All three confirmed working, no blocker.

## 3. Small fixes (non-blocking, noted only)

- Every `json.load(open(path))` call across the engine modules leaves the file
  handle to be closed by garbage collection rather than a context manager,
  producing `ResourceWarning`s under `-W error`. Cosmetic only — does not
  affect correctness, output, or the freeze decision. Not changed, since fixing
  it would touch 6 files for a non-functional issue during a freeze/approval
  phase; flagging for whenever the backend is next touched for a real reason.

## 4. End-to-end scenario run (data → Instance → optimizer → decisions → Why → outputs → economics)

All via `engine.pipeline.run_pipeline(scenario_name)`, DEMO mode:

| Scenario | Capacity mode | Status | Objective (Rs/yr) | Financial cost (Rs/yr) | Landfilled (TPD) | Diversion | Power matched (MWh/d) | Compost matched (t/d) | Avoided emissions (tCO2e/yr) | Key decisions |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | total_network | Optimal | 9,753,485,744 | 5,545,035,744 | 4,612.0 | 61.1% | 1,812.5 | 12.0 | 1,315,275 | all DO_NOTHING |
| ghazipur_outage | total_network | Optimal | 10,585,630,629 | 5,190,930,629 | 5,912.0 | 50.2% | 1,487.5 | 12.0 | 1,078,778 | GHAZIPUR_WTE → REROUTE |
| festival_surge_mcd_20pct | total_network | Optimal | 12,523,835,744 | 6,216,635,744 | 6,912.0 | 51.2% | 1,812.5 | 12.0 | 1,315,275 | all DO_NOTHING |
| monsoon_surge_30pct | total_network | Optimal | 14,039,334,249 | 6,583,661,749 | 8,170.6 | 47.0% | 1,812.5 | 12.0 | 1,315,292 | all DO_NOTHING |
| spare_capacity_demo | incremental_spare | Optimal | 327,880,750 | 327,880,750 | 0.0 | 100.0% | 143.8 | 12.0 | 104,489 | OKHLA/GHAZIPUR/TEHKHAND → REROUTE |

Notes on reading this table:
- **financial_cost < objective** in every `total_network` row because the objective
  includes ASSUMED environmental externality pricing (`landfill_env`) that
  financial cost deliberately excludes (see §2). In `spare_capacity_demo`,
  landfilled = 0, so there's no environmental term to create a gap — the two
  numbers coincide there, correctly.
- **Compost matched is identical (12.0 t/d) across every scenario** because it
  is an AUXILIARY side-stream computed from a fixed KNOWN installed-capacity
  figure (40 TPD installed × assumed operating rate × yield), independent of
  whatever the main WTE network is doing that scenario — this is intentional,
  not a bug (see the compost-accounting fix from the prior pass).
- Compost's revenue/emissions are **never** included in the financial cost or
  avoided-emissions figures above — they're reported separately under
  `economics.auxiliary_side_streams.decentralised_compost`.

## 5. FINAL API/JSON CONTRACT for frontend

**There is no HTTP API server in this repository yet** — only the Python engine
modules. The contract below is `engine.pipeline.run_pipeline(scenario_name, mode="demo", capacity_mode=None, feedstock=None, budget_scenario=False)`'s
return value, which is the de facto API response shape (fully JSON-serializable
as verified in §2) and should be wrapped by a thin API layer (FastAPI or
otherwise) during frontend integration without changing its internal shape.

```
{
  "scenario": str,                          # e.g. "baseline"
  "scenario_description": str,
  "capacity_mode": "total_network" | "incremental_spare",
  "mode": "demo" | "validated",
  "feedstock_used": {organic_fraction, moisture_pct, contamination_pct, cn_ratio},
  "feedstock_note": str | null,
  "recipe_integration_status": str,          # states recipe is advisory-only

  "recipe": {
    "feedstock": {...},
    "methods": {
      "<composting|biomethanation|waste_to_energy|rdf>": {
        "compatibility_score": float | null,
        "category": "Compatible" | "Marginal" | "Incompatible" | "INSUFFICIENT_DATA",
        "confidence": "HIGH" | "MEDIUM" | "LOW" | "NONE",
        "factors_evaluated": str,             # e.g. "4/4 (independent factors only)"
        "limiting_factors": [str],
        "unevaluated_factors": [str],
        "diagnostics": {...},                 # e.g. moisture-derived dry_combustible_fraction, NOT scored
        "recommended_adjustment": [str],
        "explanation": str
      }, ...
    },
    "ranked_by_compatibility": [str],
    "note": str
  },

  "optimizer_result": {
    "status": "Optimal" | "Infeasible",
    "mode": str, "capacity_mode": str, "capacity_mode_note": str,
    "objective_rs_per_year": float,
    "objective_rs_per_year_note": str,        # explains gap vs financial_cost_rs_per_year
    "days_per_year_used": 365,
    "flows_tpd": {"NODE->FACILITY": float, ...},          # NOTE: tuple keys stringified as "A->B"
    "flow_cost_breakdown_rs_per_tonne": {"NODE->FACILITY": {...}, ...},
    "flow_assumption_ids": {"NODE->FACILITY": {"distance":[...],"transport_rate":[...],
                                                "processing_cost":[...],"environmental_cost":[...],
                                                "load_assumption":[...]?}, ...},
    "landfilled_tpd": {"NODE": float, ...},
    "total_landfilled_tpd": float,
    "tonnes_allocated_tpd": {"FACILITY": float, ...},
    "base_capacity_tpd": {"FACILITY": float, ...},
    "built": [str], "retrofitted": [str],
    "capacity_binding": [str],
    "caveats": [str],
    "city_reference_capacity_tpd": {value, label, state, year, provenance, evidence},
    "note_city_reference": str
  },
  "baseline_result": { ...same shape as optimizer_result... },
  "decisions": {"FACILITY": "BUILD"|"RETROFIT"|"REROUTE"|"DO_NOTHING", ...},
  "diff_vs_baseline": {"objective_delta_rs_per_year": float|null, "landfill_delta_tpd": float},

  "output_matching": null | {
    "mode": "demo", "note": str,
    "by_output_type": {
      "power_mwh": {
        "output_type": "power_mwh", "stream_scope": str,   # "PRIMARY_MAIN_NETWORK: ..."
        "matches": [{"source","demand_node","matched_quantity_per_day","transport_cost_rs_per_day"}],
        "unmet_by_demand": {...}, "unused_by_source": {...},
        "total_supply_per_day", "total_demand_per_day", "total_matched_per_day",
        "utilization_of_recovered_output_pct", "demand_fulfilment_pct", "caveats": [str]
      },
      "compost_tonnes": { ...same shape..., "stream_scope": "AUXILIARY_SIDE_STREAM: ..." }
    }
  },

  "economics": null | {
    "mode": "demo", "basis": str, "scope_note": str,
    "financial_cost_rs_per_year": {value, label, formula, evidence},
    "optimizer_objective_rs_per_year": {value, label, formula, evidence},
    "financial_vs_objective_note": str,
    "costs_rs_per_year": {processing_cost, transport_cost, landfill_cost,
                           infrastructure_capex, financial_cost_rs_per_year, cost_per_tonne},  # each {value,label,formula,evidence}
    "recovered_resource_value_rs_per_year": {value, label, formula, evidence},   # POWER ONLY
    "net_annual_cost_after_recovery_rs": {value, label, formula, evidence},
    "landfill_diversion_pct": {value, label, formula, evidence},
    "lifecycle_impact_tco2e_per_year": {transport_emissions, landfill_emissions,
                                         wte_processing_emissions, total_actual_emissions,
                                         counterfactual_if_all_landfilled, avoided_emissions},  # each {value,label,formula,evidence}
    "auxiliary_side_streams": {
      "decentralised_compost"?: {
        "scope_note": str, "not_included_in": [str],
        "modelled_revenue_rs_per_year": {value,label,formula,evidence},
        "modelled_emissions_tco2e_per_year": {value,label,formula,evidence}
      }
    },
    "caveat": str
  },

  "explanation": null | {
    "node_routing": {"NODE": [{"facility","tonnes_tpd","reasons":[str],"cost_breakdown":{...}|null}]},
    "facility_decisions": {
      "FACILITY": {"decision": str, "reasons": [str], "tonnes_allocated_tpd": float,
                   "cost_comparison": null | {"computed": bool, ...}}
    }
  }
}
```

Frontend integration notes:
- **Null-check `economics` and `output_matching`** before rendering: both are
  `null` when `optimizer_result.status != "Optimal"` or when running in
  `"validated"` mode (currently always null-producing, since validated mode
  can't complete — see README).
- **Dict keys that were Python tuples** (`(node, facility)`) are stringified as
  `"NODE->FACILITY"` in `flows_tpd`, `flow_cost_breakdown_rs_per_tonne`, and
  `flow_assumption_ids` — split on `"->"` if you need the two parts separately.
- **Every "labelled" value** (the `{value, label, formula, evidence}` shape)
  uses `label` ∈ `OBSERVED | DERIVED | ASSUMED | MODELLED` — safe to render
  directly as a badge/tooltip without re-deriving it client-side.
- **`recipe_integration_status`** should be shown wherever recipe scores are
  displayed, so the UI doesn't imply the recipe engine gates optimizer choices.
