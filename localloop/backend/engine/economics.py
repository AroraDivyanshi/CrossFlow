"""
Economic + Lifecycle Impact Engine.

Everything is computed on a consistent ANNUAL basis (DAYS_PER_YEAR from
costing.py -- the same constant the optimizer uses).

MAIN NETWORK SCOPE vs AUXILIARY SIDE-STREAM
The main network's financial cost and lifecycle emissions cover only what is
actually inside the 11,862 TPD optimizer's mass balance: the four WTE/
integrated facility_subset nodes and their power output. Decentralised
compost (installed capacity ~40 TPD) is NOT part of that mass balance -- its
input tonnage never appears in tonnes_allocated_tpd, flows_tpd, or any cost
term the optimizer solved for. So its output value and its processing
emissions are reported separately, under "auxiliary_side_streams", and are
NEVER added into the main financial_cost_rs_per_year, net cost, or lifecycle
emissions totals. If a future data source gives this stream's own processing
cost and includes its input tonnage in the mass balance, it could then join
the main totals -- until then, mixing them in would overstate what the main
network "costs" or "emits" by including a stream whose own cost was never
modelled.

FINANCIAL COST vs OPTIMIZER OBJECTIVE
financial_cost_rs_per_year here is a plain, unweighted sum of processing +
transport + landfill + infrastructure cost. This is NOT necessarily the same
number as the optimizer's own objective_rs_per_year, which applies
inst.weights to processing/transport/environmental/infrastructure terms. When
every weight is 1.0 (the default used throughout this demo) the two coincide
numerically; they are kept as separate, separately labelled fields here so
that tuning a weight (e.g. to favour lower emissions) doesn't silently change
what looks like "the annual cost".

Every returned figure is wrapped with a label:
  OBSERVED  -- a directly reported value passed through unchanged
  DERIVED   -- computed purely from OBSERVED/DERIVED inputs (no assumption
               anywhere in the calculation chain)
  MODELLED  -- computed from a chain that includes at least one ASSUMED
               coefficient (a price, tariff, emission factor, transport rate,
               or processing cost that isn't sourced) -- the honest label for
               nearly everything here, since FY2025-26 public data does not
               include per-facility costs, tariffs, or emission factors.

This engine requires DEMO mode; calling it with a validated-mode Instance
raises MissingDataError, same as the optimizer does for its own missing
fields.
"""
import json
from pathlib import Path

from . import costing
from .costing import DAYS_PER_YEAR
from .model import Instance, MissingDataError, State

ASSUMPTIONS_FILE = Path(__file__).resolve().parents[3] / "data_pack" / "primary_2025_26" / "economics_assumptions.json"

# All four facility_subset technologies are WTE/integrated-WTE under current network data --
# these ARE inside the main optimizer's mass balance.
WTE_FACILITY_IDS = {"OKHLA_WTE", "NARELA_BAWANA_INTEGRATED", "GHAZIPUR_WTE", "TEHKHAND_WTE"}


def load_economics_assumptions():
    return json.load(open(ASSUMPTIONS_FILE))


def _label(*states):
    if any(s == State.ASSUMPTION for s in states):
        return "MODELLED"
    if any(s == State.DERIVED for s in states):
        return "DERIVED"
    return "OBSERVED"


def _v(value, label, formula, evidence=""):
    return {"value": value, "label": label, "formula": formula, "evidence": evidence}


def compute_economics(inst: Instance, result: dict, output_match: dict | None = None) -> dict:
    mode = inst.mode
    if mode != "demo":
        raise MissingDataError(
            "economics engine requires DEMO-mode ASSUMED coefficients (tariffs, emission factors, "
            "processing/transport costs) that are not available in validated mode -- see "
            "economics_assumptions.json and demo_assumptions.json"
        )
    econ = load_economics_assumptions()

    tonnes_allocated = result.get("tonnes_allocated_tpd", {})
    flows = result.get("flows_tpd", {})
    landfilled = result.get("landfilled_tpd", {})
    total_landfilled = result.get("total_landfilled_tpd", 0.0)
    built, retrofitted = result.get("built", []), result.get("retrofitted", [])

    # ---- MAIN NETWORK costs (annual) -- only what the optimizer actually solved for ----
    proc_terms, proc_states = [], []
    for j, tonnes in tonnes_allocated.items():
        f = inst.facilities[j]
        pc = f.proc_cost.require(f"{j}.proc_cost", mode)
        proc_terms.append(tonnes * DAYS_PER_YEAR * pc)
        proc_states.append(f.proc_cost.state)
    processing_cost_annual = sum(proc_terms)

    trans_terms, trans_states = [], []
    rate_field = inst.transport_rs_tkm
    rate = rate_field.require("transport_rs_tkm", mode)
    for (n, j), tonnes in flows.items():
        d = inst.dist_km[n, j].require(f"dist[{n},{j}]", mode)
        trans_terms.append(tonnes * DAYS_PER_YEAR * d * rate)
        trans_states.append(inst.dist_km[n, j].state)
    trans_states.append(rate_field.state)
    transport_cost_annual = sum(trans_terms)

    lc_field = inst.landfill_cost
    lc = lc_field.require("landfill_cost", mode)
    landfill_cost_annual = total_landfilled * DAYS_PER_YEAR * lc

    infra_terms, infra_states = [], []
    for j in built:
        f = inst.facilities[j]
        infra_terms.append(f.build_capex_annual.require(f"{j}.build_capex_annual", mode))
        infra_states.append(f.build_capex_annual.state)
    for j in retrofitted:
        f = inst.facilities[j]
        infra_terms.append(f.retrofit_cost_annual.require(f"{j}.retrofit_cost_annual", mode))
        infra_states.append(f.retrofit_cost_annual.state)
    infra_annual = sum(infra_terms)

    financial_cost_annual = processing_cost_annual + transport_cost_annual + landfill_cost_annual + infra_annual
    cost_states = proc_states + trans_states + [lc_field.state] + infra_states

    tonnes_processed_annual = sum(tonnes_allocated.values()) * DAYS_PER_YEAR
    tonnes_landfilled_annual = total_landfilled * DAYS_PER_YEAR
    tonnes_generated_annual = tonnes_processed_annual + tonnes_landfilled_annual
    cost_per_tonne = (financial_cost_annual / tonnes_generated_annual) if tonnes_generated_annual > 0 else None
    landfill_diversion_pct = (
        100 * tonnes_processed_annual / tonnes_generated_annual if tonnes_generated_annual > 0 else None
    )
    diversion_label = "DERIVED" if tonnes_generated_annual > 0 else "OBSERVED"

    # ---- FINANCIAL COST vs OPTIMIZER OBJECTIVE, kept explicitly separate ----
    optimizer_objective = result.get("objective_rs_per_year")
    implied_env_gap = (optimizer_objective - financial_cost_annual) if optimizer_objective is not None else None
    objective_vs_financial_note = (
        "financial_cost_rs_per_year EXCLUDES environmental externality pricing (facility env_cost, "
        "landfill_env) by design -- those are modelled shadow prices in the optimizer's objective used to "
        "steer allocation, not real money spent. optimizer_objective_rs_per_year INCLUDES them (weighted "
        "by inst.weights). The two therefore generally differ even when every weight is 1.0, whenever "
        "environmental cost terms are nonzero -- as they are here (landfill_env is an ASSUMED nonzero "
        f"Rs/tonne figure). Observed gap this run: Rs {implied_env_gap:,.0f}/year"
        if implied_env_gap is not None else "optimizer objective not available for comparison this run."
    )

    # ---- MAIN NETWORK recovered-resource value (power only -- see module docstring) ----
    revenue_terms, revenue_states, revenue_notes = [], [], []
    if output_match is not None:
        power = output_match.get("by_output_type", {}).get("power_mwh")
        if power:
            tariff = econ["power_tariff_rs_per_kwh"]
            kwh_per_day = power["total_matched_per_day"] * 1000
            revenue_terms.append(kwh_per_day * tariff["value"] * DAYS_PER_YEAR)
            revenue_states.append(State.ASSUMPTION)
            revenue_notes.append(f"power: {power['total_matched_per_day']:.1f} MWh/day matched x "
                                  f"Rs {tariff['value']}/kWh (ASSUMPTION: {tariff['evidence'][:80]}...)")
    recovered_resource_value_annual = sum(revenue_terms)
    net_annual_cost_after_recovery = financial_cost_annual - recovered_resource_value_annual

    # ---- MAIN NETWORK emissions (annual, MODELLED) -- WTE facilities + transport + landfill only ----
    tef = econ["transport_emission_factor_kg_co2_per_tonne_km"]["value"]
    transport_emissions_tco2e = sum(
        tonnes * DAYS_PER_YEAR * inst.dist_km[n, j].value * tef / 1000.0
        for (n, j), tonnes in flows.items()
    )
    lef = econ["landfill_emission_factor_tco2e_per_tonne"]["value"]
    landfill_emissions_tco2e = tonnes_landfilled_annual * lef
    wef = econ["wte_processing_emission_factor_tco2e_per_tonne"]["value"]
    wte_processing_emissions_tco2e = sum(
        tonnes * DAYS_PER_YEAR * wef for j, tonnes in tonnes_allocated.items() if j in WTE_FACILITY_IDS
    )

    total_actual_emissions_tco2e = transport_emissions_tco2e + landfill_emissions_tco2e + wte_processing_emissions_tco2e
    counterfactual_all_landfilled_tco2e = tonnes_generated_annual * lef
    avoided_emissions_tco2e = counterfactual_all_landfilled_tco2e - total_actual_emissions_tco2e

    # ---- AUXILIARY SIDE-STREAM: decentralised compost -- NOT part of the main network's mass
    # balance, financial cost, or lifecycle totals above. Reported separately, in full, so its
    # output-matching outcome is still visible -- just not silently folded into the main numbers. ----
    auxiliary_side_streams = {}
    if output_match is not None:
        compost = output_match.get("by_output_type", {}).get("compost_tonnes")
        if compost:
            price = econ["compost_price_rs_per_tonne"]
            cef = econ["compost_processing_emission_factor_tco2e_per_tonne"]["value"]
            compost_revenue_annual = compost["total_matched_per_day"] * price["value"] * DAYS_PER_YEAR
            compost_emissions_annual = compost["total_supply_per_day"] * DAYS_PER_YEAR * cef
            auxiliary_side_streams["decentralised_compost"] = {
                "scope_note": (
                    "AUXILIARY SIDE-STREAM: this decentralised compost stream (installed capacity "
                    "~40 TPD) is NOT part of the main 11,862 TPD network optimizer's mass balance, "
                    "financial cost, or lifecycle emissions totals above -- its own processing cost is "
                    "not modelled, so including its revenue/emissions in the main totals would overstate "
                    "what the main network actually costs or emits. Shown here separately in full."
                ),
                "modelled_revenue_rs_per_year": _v(
                    compost_revenue_annual, "MODELLED",
                    "matched_compost_tonnes_per_day x price_rs_per_tonne x 365", price["evidence"],
                ),
                "modelled_emissions_tco2e_per_year": _v(
                    compost_emissions_annual, "MODELLED",
                    "compost_supply_tonnes_per_day x 365 x compost_emission_factor",
                    econ["compost_processing_emission_factor_tco2e_per_tonne"]["evidence"],
                ),
                "not_included_in": ["recovered_resource_value_rs_per_year", "net_annual_cost_after_recovery_rs",
                                     "lifecycle_impact_tco2e_per_year.total_actual_emissions",
                                     "lifecycle_impact_tco2e_per_year.avoided_emissions"],
            }

    return {
        "mode": mode,
        "basis": f"Annual (per-day flows x {DAYS_PER_YEAR})",
        "scope_note": "All figures below (outside auxiliary_side_streams) cover ONLY the main network: "
                       "the four WTE/integrated facility_subset facilities, their flows, and their power "
                       "output -- exactly what tonnes_allocated_tpd/flows_tpd in the optimizer result cover.",
        "financial_cost_rs_per_year": _v(financial_cost_annual, _label(*cost_states),
                                          "processing + transport + landfill + infrastructure (unweighted)"),
        "optimizer_objective_rs_per_year": _v(optimizer_objective, "MODELLED",
                                               "the SAME optimizer run's own weighted objective (see optimizer_result.objective_rs_per_year_note)"),
        "financial_vs_objective_note": objective_vs_financial_note,
        "costs_rs_per_year": {
            "processing_cost": _v(processing_cost_annual, _label(*proc_states),
                                   "sum(tonnes_allocated_tpd x 365 x proc_cost_rs_per_tonne)"),
            "transport_cost": _v(transport_cost_annual, _label(*trans_states),
                                  "sum(flow_tpd x 365 x distance_km x transport_rs_per_tonne_km)"),
            "landfill_cost": _v(landfill_cost_annual, _label(lc_field.state),
                                 "total_landfilled_tpd x 365 x landfill_rs_per_tonne"),
            "infrastructure_capex": _v(infra_annual, _label(*infra_states) if infra_states else "OBSERVED",
                                        "sum(annualised build/retrofit capex for chosen projects)"),
            "financial_cost_rs_per_year": _v(financial_cost_annual, _label(*cost_states),
                                              "processing + transport + landfill + infrastructure"),
            "cost_per_tonne": _v(cost_per_tonne, _label(*cost_states),
                                  "financial_cost_rs_per_year / (tonnes generated annually)"),
        },
        "recovered_resource_value_rs_per_year": _v(
            recovered_resource_value_annual, "MODELLED" if revenue_states else "OBSERVED",
            "power_mwh matched_quantity_per_day x tariff x 365 (MAIN NETWORK ONLY -- see auxiliary_side_streams for compost)",
            "; ".join(revenue_notes) if revenue_notes else "no output_match supplied -- value is 0, not evaluated",
        ),
        "net_annual_cost_after_recovery_rs": _v(
            net_annual_cost_after_recovery, "MODELLED" if revenue_states else _label(*cost_states),
            "financial_cost_rs_per_year - recovered_resource_value_rs_per_year (main network only)",
        ),
        "landfill_diversion_pct": _v(landfill_diversion_pct, diversion_label,
                                      "100 x tonnes_processed_annual / tonnes_generated_annual"),
        "lifecycle_impact_tco2e_per_year": {
            "transport_emissions": _v(transport_emissions_tco2e, "MODELLED",
                                       "sum(flow_tpd x 365 x distance_km x transport_emission_factor) / 1000",
                                       econ["transport_emission_factor_kg_co2_per_tonne_km"]["evidence"]),
            "landfill_emissions": _v(landfill_emissions_tco2e, "MODELLED",
                                      "tonnes_landfilled_annual x landfill_emission_factor",
                                      econ["landfill_emission_factor_tco2e_per_tonne"]["evidence"]),
            "wte_processing_emissions": _v(wte_processing_emissions_tco2e, "MODELLED",
                                            "sum(tonnes_allocated_annual at WTE facilities x wte_emission_factor)",
                                            econ["wte_processing_emission_factor_tco2e_per_tonne"]["evidence"]),
            "total_actual_emissions": _v(total_actual_emissions_tco2e, "MODELLED",
                                          "transport + landfill + wte_processing (MAIN NETWORK ONLY)"),
            "counterfactual_if_all_landfilled": _v(counterfactual_all_landfilled_tco2e, "MODELLED",
                                                     "tonnes_generated_annual x landfill_emission_factor"),
            "avoided_emissions": _v(avoided_emissions_tco2e, "MODELLED",
                                     "counterfactual_if_all_landfilled - total_actual_emissions"),
        },
        "auxiliary_side_streams": auxiliary_side_streams,
        "caveat": econ["modelled_impact_caveat"],
    }
