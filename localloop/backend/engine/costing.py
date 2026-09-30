"""
Shared, unweighted, per-tonne cost components. These are the "real" Rs figures
(no objective-function weights applied) used for reporting, explanation and
economics -- as opposed to optimizer.py's weighted objective coefficients,
which exist only to steer the solver.

DAYS_PER_YEAR anchors every annualisation in the codebase to one place.
"""
from .model import Instance

DAYS_PER_YEAR = 365


def flow_unit_cost_rs_per_tonne(inst: Instance, n: str, j: str, mode: str) -> dict:
    f = inst.facilities[j]
    d = inst.dist_km[n, j].require(f"dist[{n},{j}]", mode)
    pc = f.proc_cost.require(f"{j}.proc_cost", mode)
    ec = f.env_cost.require(f"{j}.env_cost", mode)
    rate = inst.transport_rs_tkm.require("transport_rs_tkm", mode)
    trans = d * rate
    return {"proc_rs_per_tonne": pc, "trans_rs_per_tonne": trans, "env_rs_per_tonne": ec,
            "distance_km": d, "total_rs_per_tonne": pc + trans + ec}


def landfill_unit_cost_rs_per_tonne(inst: Instance, mode: str) -> dict:
    lc = inst.landfill_cost.require("landfill_cost", mode)
    le = inst.landfill_env.require("landfill_env", mode)
    return {"landfill_rs_per_tonne": lc, "env_rs_per_tonne": le, "total_rs_per_tonne": lc + le}
