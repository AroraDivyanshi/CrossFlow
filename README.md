# CrossFlow

**Operating Intelligence for Distributed Resource Recovery** — a decision-intelligence
backend for decentralized municipal solid waste processing networks, built against
an FY2025-26 Delhi baseline.

CrossFlow answers one question per locality/network: **BUILD, RETROFIT, REROUTE, or DO
NOTHING?** — by optimizing waste allocation across existing and candidate processing
facilities, not by assuming any one technology is automatically the right answer.

This repository currently contains the **backend only** (frontend work has not started).
The backend is implemented as a set of Python modules (`localloop/backend/engine/`) — the
`localloop` path is an internal/historical module name and is not renamed as part of the
CrossFlow project naming, per project convention of not renaming internal identifiers.

## Status: Backend frozen for frontend development

The backend has passed a full correction and freeze-check pass. See
`localloop/backend/FREEZE_REPORT.md` for the complete test results, scenario outputs, and
the JSON contract the frontend should consume.

## Repository layout

```
CrossFlow/
├── data_pack/                        # Source data, provenance, and assumptions
│   ├── provenance.csv                # Every sourced value: source, dataset, year, variable
│   ├── conflicts.csv                 # Documented conflicts between sources, left unresolved
│   ├── recipe_thresholds.json        # Auditable thresholds for the waste recipe engine
│   ├── primary_2025_26/              # The FROZEN FY2025-26 baseline used by the backend
│   │   ├── network_2025_26.json      # KNOWN/DERIVED/PENDING/UNKNOWN network snapshot
│   │   ├── demo_assumptions.json     # DEMO-mode-only assumptions (facility status/load/cost/coords)
│   │   ├── output_assumptions.json   # Output yields, demand nodes (power, compost)
│   │   ├── economics_assumptions.json # Tariffs, prices, emission factors
│   │   └── VALIDATION_REPORT.md      # Arithmetic/consistency checks on the baseline
│   └── reference/                    # Superseded historical datasets, kept for reference only
│
└── localloop/backend/                # The backend implementation (internal module name)
    ├── engine/
    │   ├── model.py          # Field/State (KNOWN/DERIVED/ASSUMPTION/PENDING/UNRESOLVED/UNKNOWN)
    │   ├── build_instance.py # network_2025_26.json (+ demo_assumptions.json) -> Instance
    │   ├── costing.py        # Shared unweighted per-tonne cost helpers
    │   ├── optimizer.py      # MILP: TOTAL_NETWORK / INCREMENTAL_SPARE, BUILD/RETROFIT
    │   ├── scenarios.py      # baseline, ghazipur_outage, festival/monsoon surge, spare-capacity demo
    │   ├── explain.py        # Structured Why engine — every claim computed, not asserted
    │   ├── outputs.py        # Output-first matching (power, compost) via LP
    │   ├── recipe.py         # Rule-based feedstock compatibility (advisory only)
    │   ├── economics.py      # Annual costs/revenue/emissions, OBSERVED/DERIVED/ASSUMED/MODELLED
    │   ├── pipeline.py       # Integrates all stages into one run — the de facto API contract
    │   └── loader.py         # CLI: lists every field blocking a VALIDATED-mode run
    ├── tests/                 # 57 tests, all passing (no pytest dependency — see tests/)
    ├── run_demo.py            # Runnable entry point for all scenarios
    └── FREEZE_REPORT.md       # Full freeze-check report: tests, scenarios, JSON contract

```

## Two data modes

- **VALIDATED** — accepts only officially sourced (KNOWN/DERIVED) values. Currently
  **not runnable end-to-end**: FY2025-26 public sources do not include per-facility
  load, cost, coordinates, or transport rates. This is the honest state of public
  data, not a bug — run `python3 -m engine.loader` to see exactly what's missing.
- **DEMO** — layers in explicitly labelled prototype ASSUMPTIONS (with evidence) for
  the fields above, so the full pipeline can run and be demonstrated end-to-end.
  Every assumed value is traceable back to its evidence string.

## Running it

```bash
cd localloop/backend
python3 -m tests.test_optimizer     # 24 tests
python3 -m tests.test_engines       # 33 tests
python3 run_demo.py baseline        # or: ghazipur_outage, festival_surge_mcd_20pct,
                                     #     monsoon_surge_30pct, spare_capacity_demo
```

See `FREEZE_REPORT.md` for the full JSON shape returned by `engine.pipeline.run_pipeline()`.
