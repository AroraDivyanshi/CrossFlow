"""
Explainable "Why?" engine.

Every reason code here is computed from the actual Instance and solve()
result. Where a claim like "X was cheaper" is made, it is qualified by WHY X
wasn't used -- capacity-binding, unavailable (outage/not built), or simply
not selected by the global optimum -- rather than a single blanket
"capacity-constrained" label applied regardless of what actually happened.
Where a claim like "building was cheaper than landfill" is made, the actual
per-tonne numbers are computed and returned alongside it (see
_build_or_retrofit_cost_comparison); if a required cost input is unknown, the
comparison is marked not computed rather than silently defaulting that input
to 0 (which would bias the comparison toward "build looks cheap").

This module produces structured data only. Turning it into prose is a UI/LLM
concern deliberately kept out of here, per the "LLM may verbalize but not
decide" rule.
"""
from . import costing
from .model import Instance, MissingDataError


def explain_node_routing(inst: Instance, result: dict) -> dict:
    """For every source node, explain why its waste went where it went."""
    mode = inst.mode
    out = {}
    for n in inst.supply:
        costs = {}
        for j, f in inst.facilities.items():
            try:
                costs[j] = costing.flow_unit_cost_rs_per_tonne(inst, n, j, mode)
            except MissingDataError:
                continue
        cheapest_id = min(costs, key=lambda j: costs[j]["total_rs_per_tonne"]) if costs else None
        shortest_id = min(costs, key=lambda j: costs[j]["distance_km"]) if costs else None

        entries = []
        for (nn, j), tonnes in result.get("flows_tpd", {}).items():
            if nn != n:
                continue
            reasons = []
            if j == cheapest_id:
                reasons.append("LOWEST_MODELED_LANDED_COST")
            elif cheapest_id is not None:
                delta = round(costs[j]["total_rs_per_tonne"] - costs[cheapest_id]["total_rs_per_tonne"], 2)
                cheapest_status = inst.facilities[cheapest_id].status
                # Distinguish WHY the cheaper option wasn't used here, rather than asserting
                # "capacity-constrained" regardless of what actually happened:
                if cheapest_status != "operating":
                    reasons.append(
                        f"LOWER_MODELED_COST_OPTION_UNAVAILABLE: {cheapest_id} was Rs {delta}/tonne cheaper "
                        f"but its status is '{cheapest_status}' (not available in this run)"
                    )
                elif cheapest_id in result.get("capacity_binding", []):
                    reasons.append(
                        f"LOWER_MODELED_COST_OPTION_CAPACITY_BINDING: {cheapest_id} was Rs {delta}/tonne "
                        f"cheaper but its modeled capacity was fully committed (to this and/or other nodes)"
                    )
                else:
                    reasons.append(
                        f"LOWER_MODELED_COST_OPTION_NOT_SELECTED_BY_SOLVER: {cheapest_id} was Rs {delta}/tonne "
                        f"cheaper and had modeled capacity available, but the global cost-minimising solution "
                        f"routed this node's waste elsewhere -- often because {cheapest_id}'s capacity was "
                        f"needed for a different node with fewer/costlier alternatives"
                    )
            if j == shortest_id:
                reasons.append("SHORTEST_MODELED_ROUTE_DISTANCE")
            if j in result.get("capacity_binding", []):
                reasons.append("CAPACITY_BINDING_AT_DESTINATION")
            entries.append({"facility": j, "tonnes_tpd": tonnes, "reasons": reasons, "cost_breakdown": costs.get(j)})

        lf = result.get("landfilled_tpd", {}).get(n)
        if lf:
            operating_facs = [j for j, f in inst.facilities.items() if f.status == "operating"]
            all_binding = operating_facs and all(j in result.get("capacity_binding", []) for j in operating_facs)
            reason = (
                "ALL_OPERATING_FACILITY_CAPACITY_EXHAUSTED" if all_binding
                else "RESIDUAL_ALLOCATION_TO_LANDFILL (some capacity existed elsewhere but was not the "
                     "optimal or reachable destination for this remainder)"
            )
            entries.append({"facility": "LANDFILL", "tonnes_tpd": lf, "reasons": [reason]})

        out[n] = entries
    return out


def _build_or_retrofit_cost_comparison(inst, f, mode, realized_tonnes_per_day, capex_annual):
    """Computes a per-tonne comparison between the build/retrofit path (at realized
    utilisation) and landfill -- never asserts an outcome without computing it, and never
    substitutes 0 for an unknown processing cost (that would silently bias the comparison
    toward "build looks cheap"). Transport is node-specific and excluded here for a single
    per-facility number; the solver's real decision does account for transport per node."""
    landfill_total = costing.landfill_unit_cost_rs_per_tonne(inst, mode)["total_rs_per_tonne"]
    if realized_tonnes_per_day <= 0:
        return {
            "computed": False,
            "reason": "facility built/retrofitted but realized 0 tonnes/day in this result -- "
                      "no per-tonne comparison can be computed; this may indicate over-provisioning "
                      "or a budget/feasibility artifact worth checking",
        }
    if not f.proc_cost.usable(mode):
        return {
            "computed": False,
            "reason": f"{f.id}.proc_cost is unknown in {mode} mode -- cannot compute a build-vs-landfill "
                      f"per-tonne comparison without silently assuming a processing cost",
        }
    capex_per_tonne = capex_annual / (realized_tonnes_per_day * costing.DAYS_PER_YEAR)
    proc_cost = f.proc_cost.value
    build_total_per_tonne = capex_per_tonne + proc_cost
    return {
        "computed": True,
        "capex_per_tonne_at_realized_utilisation_rs": round(capex_per_tonne, 2),
        "processing_cost_rs_per_tonne": proc_cost,
        "build_path_total_rs_per_tonne_excl_transport": round(build_total_per_tonne, 2),
        "landfill_total_rs_per_tonne": round(landfill_total, 2),
        "cheaper_than_landfill_excl_transport": build_total_per_tonne < landfill_total,
        "note": "Transport cost is node-specific and excluded from this single per-facility "
                "comparison; the solver's actual decision does include transport cost per node.",
    }


def explain_facility_decisions(inst: Instance, result: dict, baseline_result: dict | None, decisions: dict) -> dict:
    """For every facility, explain the BUILD/RETROFIT/REROUTE/DO_NOTHING label from
    classify_decisions in terms of the actual numbers that produced it."""
    out = {}
    outaged = [j for j, f in inst.facilities.items() if f.status == "outage"]
    mode = inst.mode
    for fid, dec in decisions.items():
        f = inst.facilities[fid]
        realized = result.get("tonnes_allocated_tpd", {}).get(fid, 0.0)
        reasons = [dec]
        comparison = None
        if dec == "BUILD":
            capex, adds = f.build_capex_annual.value, f.build_cap_tpd.value
            comparison = _build_or_retrofit_cost_comparison(inst, f, mode, realized, capex)
            if comparison["computed"]:
                verdict = "cheaper" if comparison["cheaper_than_landfill_excl_transport"] else "NOT cheaper"
                reasons.append(
                    f"BUILD_CHOSEN_WITHIN_BUDGET: annualised capex Rs {capex:,.0f}/yr adds {adds:.0f} TPD; "
                    f"computed per-tonne comparison (excl. transport) shows the build path is {verdict} than "
                    f"landfill: Rs {comparison['build_path_total_rs_per_tonne_excl_transport']}/tonne vs "
                    f"Rs {comparison['landfill_total_rs_per_tonne']}/tonne"
                )
            else:
                reasons.append(f"BUILD_CHOSEN_WITHIN_BUDGET: annualised capex Rs {capex:,.0f}/yr adds {adds:.0f} TPD; "
                                f"{comparison['reason']}")
        elif dec == "RETROFIT":
            cost, adds = f.retrofit_cost_annual.value, f.retrofit_adds_tpd.value
            comparison = _build_or_retrofit_cost_comparison(inst, f, mode, realized, cost)
            if comparison["computed"]:
                verdict = "cheaper" if comparison["cheaper_than_landfill_excl_transport"] else "NOT cheaper"
                reasons.append(
                    f"RETROFIT_CHOSEN_WITHIN_BUDGET: annualised cost Rs {cost:,.0f}/yr adds {adds:.0f} TPD; "
                    f"computed per-tonne comparison (excl. transport) shows the retrofit path is {verdict} than "
                    f"landfill: Rs {comparison['build_path_total_rs_per_tonne_excl_transport']}/tonne vs "
                    f"Rs {comparison['landfill_total_rs_per_tonne']}/tonne"
                )
            else:
                reasons.append(f"RETROFIT_CHOSEN_WITHIN_BUDGET: annualised cost Rs {cost:,.0f}/yr adds {adds:.0f} TPD; "
                                f"{comparison['reason']}")
        elif dec == "REROUTE":
            if outaged:
                reasons.append(f"OUTAGE_CAUSED_REROUTE: {outaged} unavailable in this scenario, flow redirected here")
            else:
                reasons.append("ALLOCATION_CHANGED_DUE_TO_SCENARIO_INPUT_CHANGE (e.g. a generation surge), "
                                "not an outage at any facility")
        elif dec == "DO_NOTHING":
            if fid in result.get("capacity_binding", []):
                reasons.append("CAPACITY_BINDING: already at modeled capacity in this run")
            else:
                reasons.append("NO_CHANGE_FROM_BASELINE_ALLOCATION: same tonnage routed here as in the baseline run")
        out[fid] = {"decision": dec, "reasons": reasons, "tonnes_allocated_tpd": realized,
                    "cost_comparison": comparison}
    return out


def explain(inst: Instance, result: dict, baseline_result: dict | None, decisions: dict) -> dict:
    return {
        "node_routing": explain_node_routing(inst, result),
        "facility_decisions": explain_facility_decisions(inst, result, baseline_result, decisions),
    }
