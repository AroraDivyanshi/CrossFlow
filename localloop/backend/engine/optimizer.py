"""
LocalLoop optimizer.

Two explicit, non-interchangeable capacity concepts (per spec):

  TOTAL_NETWORK      -- models allocation of the overall waste stream against
                        each facility's nameplate/installed capacity. Makes NO
                        claim about current utilization; it answers "how would
                        the whole network's waste be allocated if we could use
                        every tonne of installed capacity".

  INCREMENTAL_SPARE   -- models additional waste arriving ON TOP of an assumed
                        (or sourced) existing load. Available capacity =
                        max(0, nameplate_capacity - current_load). If load
                        exceeds nameplate (bad assumption or data), spare is
                        clamped to 0 and a caveat is raised rather than letting
                        a negative "capacity" enter the LP.

These are never mixed: a single solve() call uses exactly one capacity_mode,
and the result records which one, so nothing downstream can display an
INCREMENTAL_SPARE allocation as if it were a TOTAL_NETWORK plan or vice versa.

Objective is on a consistent ANNUAL basis: every per-tonne-per-day flow and
landfill cost is multiplied by DAYS_PER_YEAR before being compared against
already-annual BUILD/RETROFIT capex. There is no unit-mismatch caveat anymore
-- see test_objective_annual_unit_consistency for the check that guarantees it.

BUILD and RETROFIT are binary decisions (MILP, scipy.optimize.milp / HiGHS).
REROUTE and DO_NOTHING are read off the allocation after solving by comparing
against a baseline run (classify_decisions) -- see module docstring history in
scenarios.py for why.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

from . import costing
from .costing import DAYS_PER_YEAR
from .model import Instance, MissingDataError, State

VALID_STATUSES = {"operating", "outage", "candidate"}
CAPACITY_MODES = ("total_network", "incremental_spare")


def _facility_capacity_terms(inst: Instance, capacity_mode: str):
    if capacity_mode not in CAPACITY_MODES:
        raise ValueError(f"capacity_mode must be one of {CAPACITY_MODES}, got {capacity_mode!r}")
    base_cap, candidates, retrofits, caveats = {}, [], [], set()
    for fid, f in inst.facilities.items():
        if f.status not in VALID_STATUSES:
            raise MissingDataError(f"{fid}.status: {f.status!r} is not resolved to operating/outage/candidate")
        if f.status == "outage":
            base_cap[fid] = 0.0
            continue
        if f.status == "candidate":
            base_cap[fid] = 0.0
            if not f.build_cap_tpd.usable(inst.mode):
                raise MissingDataError(f"{fid}.build_cap_tpd required for a BUILD candidate")
            candidates.append(fid)
            continue
        # operating
        cap = f.capacity.require(f"{fid}.capacity", inst.mode)
        if capacity_mode == "total_network":
            base_cap[fid] = cap
        else:  # incremental_spare
            load = f.load.require(f"{fid}.load", inst.mode)
            spare = cap - load
            if spare < 0:
                caveats.add(
                    f"{fid}: assumed/sourced load ({load}) exceeds nameplate capacity ({cap}); "
                    f"spare clamped to 0 rather than using a negative capacity"
                )
                spare = 0.0
            base_cap[fid] = spare
        if f.retrofit_adds_tpd.usable(inst.mode):
            retrofits.append(fid)
    return base_cap, candidates, retrofits, caveats


def solve(inst: Instance, capacity_mode: str = "total_network"):
    W = inst.weights
    mode = inst.mode
    nodes = list(inst.supply)
    facs = list(inst.facilities)

    supply = {n: inst.supply[n].require(f"{n}.generation", mode) for n in nodes}
    base_cap, candidate_ids, retrofit_ids, caveats = _facility_capacity_terms(inst, capacity_mode)

    lf = costing.landfill_unit_cost_rs_per_tonne(inst, mode)
    lf_unit_annual = (lf["landfill_rs_per_tonne"] + W["env"] * lf["env_rs_per_tonne"]) * DAYS_PER_YEAR

    pairs = [(n, j) for n in nodes for j in facs]
    unit_cost_annual, cost_breakdown, assumption_ids = {}, {}, {}
    for n, j in pairs:
        f = inst.facilities[j]
        comp = costing.flow_unit_cost_rs_per_tonne(inst, n, j, mode)
        per_tonne_per_day = W["proc"] * comp["proc_rs_per_tonne"] + W["trans"] * comp["trans_rs_per_tonne"] + W["env"] * comp["env_rs_per_tonne"]
        unit_cost_annual[n, j] = per_tonne_per_day * DAYS_PER_YEAR
        cost_breakdown[n, j] = comp
        # Every cost input that fed this flow's unit cost, broken out by component, so a
        # caller can see exactly which assumptions (if any) underlie each number -- not just
        # a flattened, unlabelled set of ids.
        components = {
            "distance": sorted(set(inst.dist_km[n, j].provenance)) if inst.dist_km[n, j].state.value == "ASSUMPTION" else [],
            "transport_rate": sorted(set(inst.transport_rs_tkm.provenance)) if inst.transport_rs_tkm.state.value == "ASSUMPTION" else [],
            "processing_cost": sorted(set(f.proc_cost.provenance)) if f.proc_cost.state.value == "ASSUMPTION" else [],
            "environmental_cost": sorted(set(f.env_cost.provenance)) if f.env_cost.state.value == "ASSUMPTION" else [],
        }
        if capacity_mode == "incremental_spare" and f.load.state.value == "ASSUMPTION":
            components["load_assumption"] = sorted(set(f.load.provenance)) or ["facility_load_tpd:assumed"]
        # backfill a generic marker where an ASSUMPTION field carries no explicit provenance id,
        # so the component is still flagged as assumption-derived even without a named source row
        for key, field_obj in (("distance", inst.dist_km[n, j]), ("transport_rate", inst.transport_rs_tkm),
                                ("processing_cost", f.proc_cost), ("environmental_cost", f.env_cost)):
            if field_obj.state.value == "ASSUMPTION" and not components[key]:
                components[key] = [f"{key}:assumed"]
        assumption_ids[n, j] = {k: v for k, v in components.items() if v}

    nx, nl, nb, nr = len(pairs), len(nodes), len(candidate_ids), len(retrofit_ids)
    nv = nx + nl + nb + nr
    x0, l0, b0, r0 = 0, nx, nx + nl, nx + nl + nb

    c = np.zeros(nv)
    for k, (n, j) in enumerate(pairs):
        c[x0 + k] = unit_cost_annual[n, j]
    for i in range(nl):
        c[l0 + i] = lf_unit_annual
    for i, j in enumerate(candidate_ids):
        c[b0 + i] = W["infra"] * inst.facilities[j].build_capex_annual.require(f"{j}.build_capex_annual", mode)
    for i, j in enumerate(retrofit_ids):
        c[r0 + i] = W["infra"] * inst.facilities[j].retrofit_cost_annual.require(f"{j}.retrofit_cost_annual", mode)

    integrality = np.zeros(nv)
    integrality[b0:b0 + nb] = 1
    integrality[r0:r0 + nr] = 1
    bounds = Bounds(lb=np.zeros(nv), ub=np.concatenate([
        np.full(nx, np.inf), np.full(nl, np.inf), np.ones(nb), np.ones(nr)
    ]))

    constraints = []
    A_eq = np.zeros((nl, nv))
    for i, n in enumerate(nodes):
        for k, (a, _) in enumerate(pairs):
            if a == n:
                A_eq[i, x0 + k] = 1
        A_eq[i, l0 + i] = 1
    constraints.append(LinearConstraint(A_eq, lb=[supply[n] for n in nodes], ub=[supply[n] for n in nodes]))

    A_cap = np.zeros((len(facs), nv))
    ub_cap = np.zeros(len(facs))
    for i, j in enumerate(facs):
        for k, (_, b) in enumerate(pairs):
            if b == j:
                A_cap[i, x0 + k] = 1
        if j in candidate_ids:
            bc = inst.facilities[j].build_cap_tpd.require(f"{j}.build_cap_tpd", mode)
            A_cap[i, b0 + candidate_ids.index(j)] = -bc
        if j in retrofit_ids:
            rc = inst.facilities[j].retrofit_adds_tpd.require(f"{j}.retrofit_adds_tpd", mode)
            A_cap[i, r0 + retrofit_ids.index(j)] = -rc
        ub_cap[i] = base_cap[j]
    constraints.append(LinearConstraint(A_cap, lb=np.full(len(facs), -np.inf), ub=ub_cap))

    if inst.budget_annual.usable(mode) and (nb or nr):
        row = np.zeros(nv)
        for i, j in enumerate(candidate_ids):
            row[b0 + i] = inst.facilities[j].build_capex_annual.require(f"{j}.build_capex_annual", mode)
        for i, j in enumerate(retrofit_ids):
            row[r0 + i] = inst.facilities[j].retrofit_cost_annual.require(f"{j}.retrofit_cost_annual", mode)
        constraints.append(LinearConstraint(row, lb=-np.inf, ub=inst.budget_annual.require("budget_annual", mode)))

    res = milp(c, constraints=constraints, integrality=integrality, bounds=bounds)
    if not res.success:
        return {"status": "Infeasible", "capacity_mode": capacity_mode, "caveats": sorted(caveats), "message": res.message}

    x = res.x
    flows = {pairs[k]: float(x[x0 + k]) for k in range(nx) if x[x0 + k] > 1e-6}
    landfilled = {nodes[i]: float(x[l0 + i]) for i in range(nl) if x[l0 + i] > 1e-6}
    built = [candidate_ids[i] for i in range(nb) if x[b0 + i] > 0.5]
    retrofitted = [retrofit_ids[i] for i in range(nr) if x[r0 + i] > 0.5]
    used = {j: sum(v for (n, b), v in flows.items() if b == j) for j in facs}

    return {
        "status": "Optimal",
        "mode": mode,
        "capacity_mode": capacity_mode,
        "capacity_mode_note": (
            "TOTAL_NETWORK: capacity = nameplate/installed capacity; makes no claim about current utilization."
            if capacity_mode == "total_network" else
            "INCREMENTAL_SPARE: capacity = max(0, nameplate capacity - assumed/sourced current load); "
            "models additional waste arriving on top of existing operations."
        ),
        "objective_rs_per_year": float(res.fun),
        "objective_rs_per_year_note": (
            "This is the OPTIMIZER'S OWN weighted objective (weights: "
            f"{W}) -- it includes weighted processing/transport/infrastructure cost AND weighted "
            "environmental externality pricing (facility env_cost, landfill_env), which is a modelled "
            "shadow price used to steer allocation, not real money spent. It will generally NOT equal a "
            "plain financial annual cost even when all weights are 1.0, because financial cost excludes "
            "environmental externality pricing by design. See engine.economics.financial_cost_rs_per_year "
            "for the separately computed, real-money figure, and its own note for the exact gap."
        ),
        "days_per_year_used": DAYS_PER_YEAR,
        "flows_tpd": flows,
        "flow_cost_breakdown_rs_per_tonne": {k: cost_breakdown[k] for k in flows},
        "flow_assumption_ids": {k: assumption_ids[k] for k in flows},
        "landfilled_tpd": landfilled,
        "total_landfilled_tpd": sum(landfilled.values()),
        "tonnes_allocated_tpd": used,
        "base_capacity_tpd": base_cap,
        "built": built,
        "retrofitted": retrofitted,
        "capacity_binding": [j for j in facs if base_cap.get(j, 0) > 0 and used.get(j, 0) >= base_cap[j] - 1e-6],
        "caveats": sorted(caveats),
        "city_reference_capacity_tpd": inst.city_reference_capacity_tpd.as_dict(),
        "note_city_reference": (
            "city_reference_capacity_tpd is a separate city-level reported metric, NOT compared against "
            "or netted with tonnes_allocated_tpd/capacity_binding above -- see UNMODELED_CITY_CAPACITY."
        ),
    }


def classify_decisions(result: dict, baseline_result: dict | None, facilities: dict) -> dict:
    """Per-facility decision label. Requires a baseline (typically a total_network or
    incremental_spare run with the same capacity_mode, no scenario overrides) to distinguish
    REROUTE from DO_NOTHING; without one, flows into unbuilt/unretrofitted facilities are
    labelled ambiguous rather than guessed."""
    out = {}
    baseline_used = (baseline_result or {}).get("tonnes_allocated_tpd", {})
    for fid in facilities:
        if fid in result.get("built", []):
            out[fid] = "BUILD"
        elif fid in result.get("retrofitted", []):
            out[fid] = "RETROFIT"
        else:
            used = result.get("tonnes_allocated_tpd", {}).get(fid, 0.0)
            if baseline_result is None:
                out[fid] = "REROUTE_OR_DO_NOTHING (no baseline supplied)"
            elif abs(used - baseline_used.get(fid, 0.0)) > 1e-6:
                out[fid] = "REROUTE"
            else:
                out[fid] = "DO_NOTHING"
    return out
