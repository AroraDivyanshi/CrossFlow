"""
Covers:
  1. validated mode rejects assumptions
  2. demo mode accepts assumptions only when explicitly tagged
  3. unknown facility load cannot become derived spare capacity
  4. modeled facility capacity is not compared as if it were city-wide capacity
  5. outage scenario removes facility capacity
  6. reroute scenario changes allocation
  7. build/retrofit decisions respect available capacity and budget
  8. no double counting of city-reference and facility-subset capacity
  9. annual objective/cost-unit consistency
 10. TOTAL_NETWORK vs INCREMENTAL_SPARE semantics (incl. clamping, and that an
     incremental surge cannot exceed calculated spare capacity without landfill)

Fixtures marked TEST_FIXTURE use small invented numbers to exercise the
optimizer's logic in isolation; other tests run against the real (frozen)
network_2025_26.json + demo_assumptions.json.
"""
from contextlib import contextmanager

from engine.build_instance import build_instance
from engine.model import Facility, Field, Instance, MissingDataError, State
from engine.optimizer import DAYS_PER_YEAR, classify_decisions, solve
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

K = lambda v: Field(State.KNOWN, v)
A = lambda v, ev="test assumption": Field(State.ASSUMPTION, v, evidence=ev)


def fixture_instance(mode="validated", load=None, status="operating", assume_load=False):
    load_field = Field()
    if load is not None:
        load_field = A(load) if assume_load else K(load)
    fac = {
        "A": Facility("A", K(100), load_field, K(10), status=status),
        "B": Facility("B", K(100), K(0) if load is not None else Field(), K(20)),
    }
    dist = {("X", "A"): K(5), ("X", "B"): K(8)}
    return Instance({"X": K(120)}, fac, dist, K(2), K(50), K(0), mode=mode)


# 1. validated mode rejects assumptions
def test_validated_mode_rejects_assumption_field():
    inst = fixture_instance(mode="validated", load=90, assume_load=True)
    with pytest.raises(MissingDataError):
        solve(inst, "incremental_spare")


# 2. demo mode accepts assumptions only when explicitly tagged
def test_demo_mode_accepts_tagged_assumption():
    inst = fixture_instance(mode="demo", load=90, assume_load=True)
    r = solve(inst, "incremental_spare")
    assert r["status"] == "Optimal"
    assert r["flows_tpd"][("X", "A")] == pytest.approx(10)  # 100 - 90 spare


def test_assumption_field_requires_evidence_text():
    with pytest.raises(ValueError):
        Field(State.ASSUMPTION, 42, evidence="")


def test_demo_mode_still_rejects_pending_and_unresolved():
    inst = fixture_instance(mode="demo")
    inst.supply["X"] = Field(State.PENDING, 120)
    with pytest.raises(MissingDataError):
        solve(inst, "total_network")


# 3. unknown facility load cannot become derived spare capacity
def test_unknown_load_never_becomes_derived_spare():
    f = Facility("A", K(100))
    assert f.spare("validated").state == State.UNKNOWN
    assert f.spare("demo").state == State.UNKNOWN
    with pytest.raises(MissingDataError):
        solve(fixture_instance(mode="demo"), "incremental_spare")


def test_derived_spare_only_from_two_known_values():
    f = Facility("A", K(100), K(60))
    sp = f.spare("validated")
    assert sp.state == State.DERIVED and sp.value == 40


# 4. modeled facility capacity is not compared as if it were city-wide capacity
def test_city_reference_capacity_not_used_as_a_constraint():
    inst = build_instance(mode="demo")
    inst.facilities = {k: v for k, v in inst.facilities.items() if not v.is_candidate and v.status != "candidate"}
    for f in inst.facilities.values():
        f.retrofit_adds_tpd, f.retrofit_cost_annual = Field(), Field()
    r = solve(inst, capacity_mode="total_network")
    modeled_total = sum(r["tonnes_allocated_tpd"].values()) + r["total_landfilled_tpd"]
    city_ref = r["city_reference_capacity_tpd"]["value"]
    assert modeled_total == pytest.approx(sum(f.require("gen", "demo") for f in inst.supply.values()))
    assert "note_city_reference" in r
    assert city_ref == 7641
    assert sum(r["tonnes_allocated_tpd"].values()) != city_ref


# 5. outage scenario removes facility capacity
def test_outage_removes_capacity_total_network_mode():
    inst = fixture_instance(status="outage", mode="demo", load=0)
    r = solve(inst, "total_network")
    assert ("X", "A") not in r["flows_tpd"]
    assert r["landfilled_tpd"]["X"] == pytest.approx(20)


def test_outage_scenario_via_scenarios_module():
    out = run_scenario("ghazipur_outage", mode="demo")
    assert all(fid != "GHAZIPUR_WTE" for (n, fid) in out["result"]["flows_tpd"])
    assert out["result"]["tonnes_allocated_tpd"].get("GHAZIPUR_WTE", 0) == 0


# 6. reroute scenario changes allocation
def test_reroute_scenario_changes_allocation_vs_baseline():
    out = run_scenario("ghazipur_outage", mode="demo")
    assert out["result"]["total_landfilled_tpd"] > out["baseline"]["total_landfilled_tpd"]


def test_monsoon_surge_increases_landfill_not_capacity():
    out = run_scenario("monsoon_surge_30pct", mode="demo")
    assert out["result"]["total_landfilled_tpd"] > out["baseline"]["total_landfilled_tpd"]
    assert sum(out["result"]["tonnes_allocated_tpd"].values()) == pytest.approx(7250, abs=1)


def test_festival_surge_scenario_runs_and_changes_supply():
    out = run_scenario("festival_surge_mcd_20pct", mode="demo")
    assert out["result"]["status"] == "Optimal"
    assert out["result"]["total_landfilled_tpd"] >= out["baseline"]["total_landfilled_tpd"]


# 7. build/retrofit decisions respect available capacity and budget
def test_build_respects_budget_cap():
    fac = {
        "EXIST": Facility("EXIST", K(50), K(50), K(10)),
        "CAND": Facility("CAND", status="candidate", is_candidate=True,
                          build_capex_annual=K(3_000), build_cap_tpd=K(100), proc_cost=K(5)),
    }
    inst = Instance({"X": K(80)}, fac, {("X", "EXIST"): K(1), ("X", "CAND"): K(1)},
                    K(1), K(500), K(0), budget_annual=K(3_000), mode="validated")
    r = solve(inst, "incremental_spare")
    assert r["status"] == "Optimal"
    assert "CAND" in r["built"]
    assert r["tonnes_allocated_tpd"]["CAND"] == pytest.approx(80)


def test_build_blocked_when_budget_too_small():
    fac = {
        "EXIST": Facility("EXIST", K(50), K(50), K(10)),
        "CAND": Facility("CAND", status="candidate", is_candidate=True,
                          build_capex_annual=K(3_000), build_cap_tpd=K(100), proc_cost=K(5)),
    }
    inst = Instance({"X": K(80)}, fac, {("X", "EXIST"): K(1), ("X", "CAND"): K(1)},
                    K(1), K(500), K(0), budget_annual=K(999), mode="validated")
    r = solve(inst, "incremental_spare")
    assert "CAND" not in r["built"]
    assert r["landfilled_tpd"]["X"] == pytest.approx(80)


def test_retrofit_adds_capacity_only_when_chosen_and_affordable():
    fac = {"EXIST": Facility("EXIST", K(50), K(50), K(10),
                              retrofit_cost_annual=K(500), retrofit_adds_tpd=K(30))}
    inst = Instance({"X": K(30)}, fac, {("X", "EXIST"): K(1)}, K(1), K(500), K(0),
                    budget_annual=K(500), mode="validated")
    r = solve(inst, "incremental_spare")
    assert "EXIST" in r["retrofitted"]
    assert r["tonnes_allocated_tpd"]["EXIST"] == pytest.approx(30)


# 8. no double counting of city-reference and facility-subset capacity
def test_facility_subset_sum_not_forced_to_equal_city_reference():
    inst = build_instance(mode="demo")
    subset_sum = sum(f.capacity.value for f in inst.facilities.values() if f.capacity.usable("demo"))
    city_ref = inst.city_reference_capacity_tpd.value
    assert subset_sum == 7250
    assert city_ref == 7641
    assert subset_sum != city_ref


def test_solve_result_never_sums_city_reference_into_objective():
    inst = build_instance(mode="demo")
    inst.facilities = {k: v for k, v in inst.facilities.items() if not v.is_candidate and v.status != "candidate"}
    for f in inst.facilities.values():
        f.retrofit_adds_tpd, f.retrofit_cost_annual = Field(), Field()
    r = solve(inst, capacity_mode="total_network")
    assert isinstance(r["city_reference_capacity_tpd"], dict)
    assert r["city_reference_capacity_tpd"]["value"] != r["objective_rs_per_year"]


# 9. annual objective/cost-unit consistency
def test_objective_annual_unit_consistency_simple_case():
    """No caveat should exist anymore, and the objective must equal a hand-computed
    annualised sum: (flow x 365 x per-tonne unit cost) summed over allocated flows and
    landfill, i.e. everything on the SAME (annual) basis -- no daily-vs-annual mismatch."""
    fac = {"A": Facility("A", K(100), K(0), K(10))}  # proc_cost 10 Rs/tonne
    inst = Instance({"X": K(60)}, fac, {("X", "A"): K(5)}, K(2), K(50), K(0), mode="validated")
    r = solve(inst, "incremental_spare")
    assert "CAPEX_VS_PERDAY_COST_UNIT_MISMATCH_PROTOTYPE_ONLY" not in " ".join(r["caveats"])
    per_tonne = 10 + 5 * 2  # proc + distance*rate
    expected = 60 * DAYS_PER_YEAR * per_tonne
    assert r["objective_rs_per_year"] == pytest.approx(expected)
    assert r["days_per_year_used"] == DAYS_PER_YEAR


def test_objective_annual_unit_consistency_with_capex():
    """A capex (already annual) and a per-day flow cost must combine correctly once the
    flow cost is annualised -- verifies BUILD's contribution isn't silently re-annualised
    or left daily."""
    fac = {
        "CAND": Facility("CAND", status="candidate", is_candidate=True,
                          build_capex_annual=K(1000), build_cap_tpd=K(50), proc_cost=K(4)),
    }
    inst = Instance({"X": K(50)}, fac, {("X", "CAND"): K(0)}, K(1), K(999999), K(0),
                    budget_annual=K(1000), mode="validated")
    r = solve(inst, "incremental_spare")
    assert "CAND" in r["built"]
    expected = 1000 + 50 * DAYS_PER_YEAR * 4  # capex (already annual) + annualised flow cost
    assert r["objective_rs_per_year"] == pytest.approx(expected)


# 10. TOTAL_NETWORK vs INCREMENTAL_SPARE semantics
def test_total_network_ignores_load_uses_full_nameplate():
    inst = fixture_instance(mode="demo", load=90, assume_load=True)
    r = solve(inst, "total_network")
    assert r["flows_tpd"][("X", "A")] == pytest.approx(100)  # full nameplate, load irrelevant
    assert r["capacity_mode"] == "total_network"


def test_incremental_spare_uses_only_capacity_minus_load():
    inst = fixture_instance(mode="demo", load=90, assume_load=True)
    r = solve(inst, "incremental_spare")
    assert r["flows_tpd"][("X", "A")] == pytest.approx(10)  # 100 - 90
    assert r["capacity_mode"] == "incremental_spare"


def test_incremental_spare_clamps_negative_spare_to_zero_with_caveat():
    inst = fixture_instance(mode="demo", load=150, assume_load=True)  # load > capacity
    r = solve(inst, "incremental_spare")
    assert r["flows_tpd"].get(("X", "A"), 0) == 0
    assert any("clamped to 0" in c for c in r["caveats"])


def test_incremental_surge_cannot_exceed_spare_capacity_without_landfill():
    """A surge larger than the calculated spare capacity MUST spill to landfill --
    it cannot be silently absorbed by exceeding the derived spare figure."""
    inst = fixture_instance(mode="demo", load=90, assume_load=True)  # A has 10 spare, B has 100 spare
    inst.supply["X"] = A(250)  # demand far exceeds total spare (110)
    r = solve(inst, "incremental_spare")
    assert r["flows_tpd"][("X", "A")] == pytest.approx(10)
    assert r["flows_tpd"][("X", "B")] == pytest.approx(100)
    assert r["landfilled_tpd"]["X"] == pytest.approx(140)  # 250 - 110, cannot exceed spare


def test_spare_capacity_demo_scenario_models_only_incremental_surge():
    """The spare_capacity_demo scenario must NOT re-supply the full 11,500 TPD MCD
    baseline as new demand -- only the incremental surge fraction. Nodes with no
    explicit surge fraction (NDMC, DCB) must contribute ZERO, not their own baseline."""
    out = run_scenario("spare_capacity_demo", mode="demo")
    assert out["capacity_mode"] == "incremental_spare"
    from engine.build_instance import build_instance as _bi
    inst = _bi(mode="demo", overrides=out["overrides_applied"])
    mcd_supply = inst.supply["MCD"].value
    assert mcd_supply == pytest.approx(11500 * 0.05)  # ONLY the 5% surge, not 11500 or 11500*1.05
    assert inst.supply["NDMC"].value == pytest.approx(0.0)  # NOT its 300 TPD baseline
    assert inst.supply["DCB"].value == pytest.approx(0.0)   # NOT its 62 TPD baseline
    total_demand_modelled = sum(f.value for f in inst.supply.values())
    assert total_demand_modelled == pytest.approx(575.0)  # exactly the MCD surge, nothing else
    assert out["result"]["status"] == "Optimal"


if __name__ == "__main__":
    import sys
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
