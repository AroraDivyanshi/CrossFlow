# CrossFlow Backend — Freeze Report

**Status: APPROVED / FROZEN**

This report records the final verified state of the CrossFlow backend and API used by the frontend.

## 1. Test Results

| Test Suite | Tests | Passed | Failed |
|---|---:|---:|---:|
| `tests/test_optimizer.py` | 24 | 24 | 0 |
| `tests/test_engines.py` | 33 | 33 | 0 |
| **Total** | **57** | **57** | **0** |

The backend tests cover optimizer behaviour, scenarios, economics, outputs, recipe scoring, explanations, provenance handling and engine integration.

## 2. Scenario Verification

All five configured scenarios execute successfully in DEMO mode:

- `baseline`
- `ghazipur_outage`
- `festival_surge_mcd_20pct`
- `monsoon_surge_30pct`
- `spare_capacity_demo`

Representative frozen results:

| Scenario | Landfilled (TPD) | Diversion | Power Matched (MWh/d) |
|---|---:|---:|---:|
| Baseline | 4,612 | 61.1% | 1,812.5 |
| Ghazipur outage | 5,912 | 50.2% | 1,487.5 |
| Festival surge | 6,912 | 51.2% | 1,812.5 |
| Monsoon surge | 8,170.6 | 47.0% | 1,812.5 |
| Spare-capacity demo | 0 | 100% | 143.8 |

The Ghazipur outage correctly produces a rerouting response rather than treating the facility as available.

## 3. Pipeline Verification

The current pipeline is:

```text
Recipe Advisory
      ↓
Scenario + Optimizer
      ↓
Recovered Outputs
      ↓
Output Matching
      ↓
Economics / Lifecycle Impact
      ↓
Why Explanation
```

The Recipe Engine remains **advisory-only** and does not silently constrain the optimizer.

Output matching consumes the actual allocation produced by the optimizer rather than independently inventing supply.

Economics keeps **financial cost** separate from the optimizer objective, which may include the modelled environmental externality term.

## 4. API Verification

The backend now exposes a lightweight HTTP API through:

```text
localloop/backend/api/server.py
```

Current endpoints:

```text
GET /api/health
GET /api/scenarios
GET /api/network
GET /api/recipe
GET /api/pipeline/<scenario>
```

Pipeline requests support:

```text
mode=demo|validated
capacity_mode=total_network|incremental_spare
```

Expected error handling is preserved for invalid requests, missing validated-mode data and unknown scenarios/routes.

The API is a thin wrapper around the existing backend pipeline and does not duplicate business logic.

## 5. Data & Assumption Policy

The backend continues to distinguish:

- **Observed / Known**
- **Derived**
- **Modelled**
- **Assumed**
- **Pending / Unknown**

DEMO mode may use explicitly labelled assumptions.

Validated mode does not silently fabricate missing values.

The decentralized compost stream remains an auxiliary side-stream and is not counted as additional WTE network capacity.

## 6. Known Limitations

- Some economic/feedstock parameters remain modelled or assumed for DEMO operation.
- Validated mode intentionally rejects requests when required data is unavailable.
- The current HTTP API is designed for prototype/demo deployment rather than production-scale municipal operations.
- Final production deployment still requires environment-specific API URL and hosting configuration.

## 7. Freeze Conclusion

The CrossFlow backend is considered **stable for frontend integration and hackathon demonstration**.

No known functional blockers remain.

Further changes should be limited to:

- genuine bug fixes
- deployment configuration
- explicit data updates
- API extensions requiring a new verification pass

**CrossFlow — Optimize the network, not just the technology.**