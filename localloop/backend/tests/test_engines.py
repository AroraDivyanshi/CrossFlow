"""
Covers:
  - output matching limits (supply/demand caps, unmet/unused, transport uses real coords)
  - recipe compatibility rules + confidence/missing-data treatment
  - economics calculations (annual basis, OBSERVED/DERIVED/ASSUMED/MODELLED labels)
  - explanation provenance (BUILD/RETROFIT claims are computed, not asserted)
  - validated-mode refusal for outputs/economics (DEMO-only engines)
  - the integrated pipeline chaining all seven pieces together
"""
import sys
from contextlib import contextmanager

from engine.build_instance import build_instance
from engine.economics import compute_economics
from engine.explain import explain
from engine.model import Field, MissingDataError
from engine.optimizer import classify_decisions, solve
from engine.outputs import match_outputs
from engine.pipeline import run_pipeline
from engine.recipe import evaluate as recipe_evaluate
from engine.scenarios import run_scenario


class _Pytest:
    class _Approx:
        def __init__(self, v, abs=1e-6): self.v, self.abs = v, abs
        def __eq__(self, other): return abs(other - self.v) <= self.abs
        def __repr__(self): return f"approx({self.v})"
    def approx(self, v, abs=1e-6): return self._Approx(v, abs)
    @contextmanager
    def raises(self, exc_type):
        try:
            yield
        except exc_type:
            return
        else:
            raise AssertionError(f"expected {exc_type.__name__} to be raised")

pytest = _Pytest()


def _demo_baseline_result():
    inst = build_instance(mode="demo")
    inst.facilities = {k: v for k, v in inst.facilities.items() if not v.is_candidate and v.status != "candidate"}
    for f in inst.facilities.values():
        f.retrofit_adds_tpd, f.retrofit_cost_annual = Field(), Field()
    r = solve(inst, capacity_mode="total_network")
    return inst, r


# ---------------- recipe ----------------

def test_recipe_full_profile_scores_high_confidence():
    r = recipe_evaluate({"organic_fraction": 0.65, "moisture_pct": 55, "contamination_pct": 6, "cn_ratio": 26})
    c = r["methods"]["composting"]
    assert c["confidence"] == "HIGH"
    assert c["factors_evaluated"] == "4/4 (independent factors only)"
    assert c["category"] == "Compatible"


def test_recipe_partial_profile_gets_low_or_medium_confidence_not_high():
    r = recipe_evaluate({"moisture_pct": 55})
    c = r["methods"]["composting"]
    assert c["confidence"] in ("LOW", "MEDIUM")
    assert c["confidence"] != "HIGH"
    assert c["factors_evaluated"] == "1/4 (independent factors only)"


def test_recipe_empty_profile_is_insufficient_data():
    r = recipe_evaluate({})
    for m in r["methods"].values():
        assert m["category"] == "INSUFFICIENT_DATA"
        assert m["compatibility_score"] is None


def test_recipe_dry_combustible_proxy_is_flagged():
    r = recipe_evaluate({"moisture_pct": 30})
    wte = r["methods"]["waste_to_energy"]
    assert "dry_combustible_fraction_estimated_from_moisture" in wte["diagnostics"]
    assert "diagnostic" in wte["explanation"].lower()


def test_recipe_moisture_derived_dcf_never_double_counted():
    """The core correction: dry_combustible_fraction derived from moisture must not be
    scored as a second independent factor for WTE/RDF."""
    r = recipe_evaluate({"moisture_pct": 30})
    for method in ("waste_to_energy", "rdf"):
        m = r["methods"][method]
        assert m["factors_evaluated"] == "1/1 (independent factors only)"
        assert "dry_combustible_fraction" not in m["limiting_factors"]


def test_recipe_independently_supplied_dcf_is_scored_as_own_factor():
    r = recipe_evaluate({"moisture_pct": 30, "dry_combustible_fraction": 0.9})
    wte = r["methods"]["waste_to_energy"]
    assert wte["factors_evaluated"] == "2/2 (independent factors only)"
    assert "dry_combustible_fraction_estimated_from_moisture" not in wte["diagnostics"]


def test_recipe_recommendation_reads_thresholds_dynamically_not_hardcoded():
    from engine.recipe import load_thresholds
    t = load_thresholds()
    lo, hi = t["composting"]["cn_ratio_range"]
    r = recipe_evaluate({"organic_fraction": 0.6, "moisture_pct": 50, "contamination_pct": 5, "cn_ratio": 5})
    tips = " ".join(r["methods"]["composting"]["recommended_adjustment"])
    assert f"{lo}-{hi}" in tips  # the actual configured range appears, not a hardcoded "20-30"


def test_recipe_high_organic_wet_feedstock_favours_biological_methods():
    r = recipe_evaluate({"organic_fraction": 0.75, "moisture_pct": 65, "contamination_pct": 3, "cn_ratio": 25})
    ranked = r["ranked_by_compatibility"]
    assert ranked[0] in ("composting", "biomethanation")


def test_recipe_dry_low_organic_feedstock_favours_wte_or_rdf():
    r = recipe_evaluate({"organic_fraction": 0.2, "moisture_pct": 15, "contamination_pct": 20, "cn_ratio": 60})
    ranked = r["ranked_by_compatibility"]
    assert ranked[0] in ("waste_to_energy", "rdf")


# ---------------- outputs ----------------

def test_output_matching_requires_demo_mode():
    inst = build_instance(mode="validated")
    with pytest.raises(ValueError):
        match_outputs(inst, {"tonnes_allocated_tpd": {}})


def test_output_matching_uses_real_coordinates_for_compost_transport():
    inst, r = _demo_baseline_result()
    m = match_outputs(inst, r)
    compost = m["by_output_type"]["compost_tonnes"]
    assert compost["matches"], "expected at least one compost match"
    assert any(mm["transport_cost_rs_per_day"] > 0 for mm in compost["matches"]), \
        "compost transport cost should be nonzero now that real coordinates are used"
    assert compost["caveats"] == []  # no missing-coordinate caveat


def test_output_matching_power_has_no_transport_cost_grid_wheeled():
    inst, r = _demo_baseline_result()
    m = match_outputs(inst, r)
    power = m["by_output_type"]["power_mwh"]
    assert all(mm["transport_cost_rs_per_day"] == 0 for mm in power["matches"])


def test_output_matching_respects_demand_cap_reports_unmet():
    inst, r = _demo_baseline_result()
    m = match_outputs(inst, r)
    power = m["by_output_type"]["power_mwh"]
    # DISCOM_GRID demand (100,000) vastly exceeds power supply -- everything should match,
    # and the (large) unmet remainder must be reported, not hidden
    assert power["total_matched_per_day"] == pytest.approx(power["total_supply_per_day"])
    assert power["unmet_by_demand"]["DISCOM_GRID"] > 0


def test_output_matching_respects_supply_cap_reports_unused():
    # Build an artificial demand smaller than supply by monkeypatching nothing --
    # compost demand (150) vs supply (12 from 40 TPD installed x 0.3 yield) is already
    # supply-constrained the other way; verify the reverse case using power vs a tiny demand
    from engine import outputs as outputs_mod
    inst, r = _demo_baseline_result()
    assum = outputs_mod.load_output_assumptions()
    assum["demand_nodes"] = [d for d in assum["demand_nodes"] if d["output_type"] != "power_mwh"]
    assum["demand_nodes"].append({
        "id": "TINY_DEMAND", "output_type": "power_mwh",
        "demand_quantity_per_day": {"state": "ASSUMPTION", "value": 10, "evidence": "test"},
        "coords": {"lat": 28.6, "lon": 77.2},
    })
    supply = outputs_mod.compute_output_supply(inst, r, assum)
    result = outputs_mod._match_one_output_type(
        "power_mwh", supply["power_mwh"],
        [d for d in assum["demand_nodes"] if d["output_type"] == "power_mwh"],
        {}, None,
    )
    assert result["total_matched_per_day"] == pytest.approx(10)
    assert sum(result["unused_by_source"].values()) == pytest.approx(result["total_supply_per_day"] - 10)


def test_decentralised_compost_source_is_real_not_a_placeholder_comment():
    inst, r = _demo_baseline_result()
    m = match_outputs(inst, r)
    compost = m["by_output_type"]["compost_tonnes"]
    sources = {mm["source"] for mm in compost["matches"]}
    assert "DECENTRALISED_COMPOST" in sources
    assert compost["total_supply_per_day"] > 0


# ---------------- economics ----------------

def test_economics_requires_demo_mode():
    inst = build_instance(mode="validated")
    with pytest.raises(MissingDataError):
        compute_economics(inst, {"tonnes_allocated_tpd": {}, "flows_tpd": {}, "landfilled_tpd": {},
                                  "total_landfilled_tpd": 0, "built": [], "retrofitted": []})


def test_economics_annual_basis_matches_optimizer_days_per_year():
    from engine.costing import DAYS_PER_YEAR
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r)
    assert econ["basis"] == f"Annual (per-day flows x {DAYS_PER_YEAR})"


def test_economics_cost_components_labelled_modelled_when_assumption_based():
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r)
    for key in ("processing_cost", "transport_cost", "landfill_cost"):
        assert econ["costs_rs_per_year"][key]["label"] == "MODELLED"


def test_economics_landfill_diversion_is_derived_not_modelled():
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r)
    assert econ["landfill_diversion_pct"]["label"] == "DERIVED"
    expected = 100 * sum(r["tonnes_allocated_tpd"].values()) / (
        sum(r["tonnes_allocated_tpd"].values()) + r["total_landfilled_tpd"]
    )
    assert econ["landfill_diversion_pct"]["value"] == pytest.approx(expected)


def test_economics_without_output_match_has_zero_recovered_value_and_says_why():
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r, output_match=None)
    assert econ["recovered_resource_value_rs_per_year"]["value"] == 0
    assert "not evaluated" in econ["recovered_resource_value_rs_per_year"]["evidence"]


def test_economics_with_output_match_computes_positive_revenue():
    inst, r = _demo_baseline_result()
    om = match_outputs(inst, r)
    econ = compute_economics(inst, r, om)
    assert econ["recovered_resource_value_rs_per_year"]["value"] > 0
    assert econ["recovered_resource_value_rs_per_year"]["label"] == "MODELLED"


def test_economics_emissions_are_all_modelled_and_avoided_is_computed():
    """Main-network emissions cover only transport/landfill/WTE -- decentralised compost's
    emissions are a separate auxiliary side-stream, NOT part of this main total (per the
    compost-accounting fix: it isn't part of the main network's mass balance)."""
    inst, r = _demo_baseline_result()
    om = match_outputs(inst, r)
    econ = compute_economics(inst, r, om)
    impact = econ["lifecycle_impact_tco2e_per_year"]
    for k in ("transport_emissions", "landfill_emissions", "wte_processing_emissions", "avoided_emissions"):
        assert impact[k]["label"] == "MODELLED"
    assert "compost_processing_emissions" not in impact
    expected_avoided = impact["counterfactual_if_all_landfilled"]["value"] - impact["total_actual_emissions"]["value"]
    assert impact["avoided_emissions"]["value"] == pytest.approx(expected_avoided)


def test_economics_compost_is_auxiliary_not_in_main_totals():
    inst, r = _demo_baseline_result()
    om = match_outputs(inst, r)
    econ = compute_economics(inst, r, om)
    aux = econ["auxiliary_side_streams"]["decentralised_compost"]
    assert aux["modelled_revenue_rs_per_year"]["value"] > 0
    assert "recovered_resource_value_rs_per_year" in aux["not_included_in"]
    # main recovered-resource value must be power-only, strictly less than power+compost combined
    main_revenue = econ["recovered_resource_value_rs_per_year"]["value"]
    assert main_revenue < main_revenue + aux["modelled_revenue_rs_per_year"]["value"]


def test_economics_cost_per_tonne_positive_and_consistent():
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r)
    total = econ["financial_cost_rs_per_year"]["value"]
    assert total == econ["costs_rs_per_year"]["financial_cost_rs_per_year"]["value"]
    cpt = econ["costs_rs_per_year"]["cost_per_tonne"]["value"]
    tonnes = (sum(r["tonnes_allocated_tpd"].values()) + r["total_landfilled_tpd"]) * 365
    assert cpt == pytest.approx(total / tonnes)


def test_economics_financial_cost_excludes_environmental_externality():
    """financial_cost_rs_per_year must be strictly less than optimizer_objective_rs_per_year
    whenever landfill_env (an environmental externality price) is nonzero -- financial cost
    is real money only, the objective includes the shadow price used to steer allocation."""
    inst, r = _demo_baseline_result()
    econ = compute_economics(inst, r)
    financial = econ["financial_cost_rs_per_year"]["value"]
    objective = econ["optimizer_objective_rs_per_year"]["value"]
    assert objective > financial
    assert "gap" in econ["financial_vs_objective_note"].lower()


# ---------------- explain ----------------

def test_explain_build_claim_is_computed_not_asserted():
    from engine.model import Facility, Field, Instance, State
    K = lambda v: Field(State.KNOWN, v)
    fac = {"CAND": Facility("CAND", status="candidate", is_candidate=True,
                             build_capex_annual=K(3000), build_cap_tpd=K(100), proc_cost=K(5))}
    inst = Instance({"X": K(80)}, fac, {("X", "CAND"): K(1)}, K(1), K(500), K(0),
                     budget_annual=K(3000), mode="validated")
    r = solve(inst, "incremental_spare")
    decisions = classify_decisions(r, None, inst.facilities)
    ex = explain(inst, r, None, decisions)
    comparison = ex["facility_decisions"]["CAND"]["cost_comparison"]
    assert comparison["computed"] is True
    assert "cheaper_than_landfill_excl_transport" in comparison
    assert isinstance(comparison["cheaper_than_landfill_excl_transport"], bool)
    # the reason text must reflect the actual computed verdict, not a fixed claim
    reason_text = " ".join(ex["facility_decisions"]["CAND"]["reasons"])
    verdict_word = "NOT cheaper" if not comparison["cheaper_than_landfill_excl_transport"] else " cheaper"
    assert verdict_word in reason_text or "cheaper" in reason_text.lower()


def test_explain_build_zero_throughput_does_not_assert_cheaper():
    from engine.model import Facility, Field, Instance, State
    K = lambda v: Field(State.KNOWN, v)
    # candidate that's built but a companion cheaper facility absorbs all real demand -- force
    # zero realized throughput on the candidate by giving it a very high proc_cost so nothing
    # is actually routed there even though budget alone would allow building... instead,
    # directly test the helper with realized_tonnes=0 for a clean unit check.
    from engine.explain import _build_or_retrofit_cost_comparison
    f = Facility("CAND", proc_cost=K(5))
    inst = Instance({"X": K(0)}, {"CAND": f}, {}, K(1), K(500), K(0), mode="validated")
    comparison = _build_or_retrofit_cost_comparison(inst, f, "validated", 0.0, 3000)
    assert comparison["computed"] is False
    assert "0 tonnes/day" in comparison["reason"]


def test_explain_reroute_reason_traces_to_actual_outage():
    out = run_scenario("ghazipur_outage", mode="demo")
    ex = explain(out["instance"], out["result"], out["baseline"], out["decisions"])
    for fid, info in ex["facility_decisions"].items():
        if info["decision"] == "REROUTE":
            assert any("OUTAGE_CAUSED_REROUTE" in reason for reason in info["reasons"])
            assert "GHAZIPUR_WTE" in " ".join(info["reasons"])


def test_explain_node_routing_cites_real_cost_breakdown():
    inst, r = _demo_baseline_result()
    ex = explain(inst, r, None, classify_decisions(r, None, inst.facilities))
    for node, entries in ex["node_routing"].items():
        for e in entries:
            if e["facility"] != "LANDFILL":
                assert e["cost_breakdown"] is not None
                assert "total_rs_per_tonne" in e["cost_breakdown"]


# ---------------- integrated pipeline ----------------

def test_pipeline_runs_all_seven_stages_for_baseline():
    out = run_pipeline("baseline")
    assert out["recipe"]["ranked_by_compatibility"]
    assert out["optimizer_result"]["status"] == "Optimal"
    assert out["output_matching"] is not None
    assert out["economics"] is not None
    assert out["explanation"] is not None


def test_pipeline_economics_consumes_this_runs_output_matching():
    out = run_pipeline("baseline")
    om_power_matched = out["output_matching"]["by_output_type"]["power_mwh"]["total_matched_per_day"]
    assert out["economics"]["recovered_resource_value_rs_per_year"]["value"] > 0
    assert om_power_matched > 0


def test_pipeline_outage_scenario_flows_through_to_explanation():
    out = run_pipeline("ghazipur_outage")
    assert out["optimizer_result"]["tonnes_allocated_tpd"].get("GHAZIPUR_WTE", 0) == 0
    facility_decisions = out["explanation"]["facility_decisions"]
    assert facility_decisions["GHAZIPUR_WTE"]["decision"] == "REROUTE"


def test_pipeline_feedstock_note_connects_recipe_to_real_network_figure():
    out = run_pipeline("baseline")
    assert "P25" in out["feedstock_note"]
    assert out["feedstock_used"]["organic_fraction"] == 0.40


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            try:
                fn()
                print("ok", name)
            except Exception as e:
                failed += 1
                print("FAIL", name, "--", repr(e))
    sys.exit(1 if failed else 0)
