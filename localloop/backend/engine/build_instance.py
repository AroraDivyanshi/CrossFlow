"""
Builds a model.Instance from the frozen FY2025-26 network snapshot, and --
only in demo mode -- the separate demo_assumptions.json file.

VALIDATED mode reads ONLY network_2025_26.json. demo_assumptions.json is never
opened. Since that file has facility load/status/proc_cost/coords/distance/
transport-cost all UNKNOWN today, a validated-mode Instance is (by design) not
solvable yet -- see MissingDataError. That is the honest state of public data,
not a bug.

DEMO mode reads both files. Every per-facility field that could plausibly one
day appear in the network file (load, processing cost) is resolved through
_facility_field(), which calls _prefer() to guarantee a KNOWN/DERIVED network
value always wins over a DEMO ASSUMPTION -- see test_build_instance.py's
regression tests for both _prefer() directly and the full build path.
"""
import json
import math
from pathlib import Path

from .model import Facility, Field, Instance, State, assumption

DATA_PACK = Path(__file__).resolve().parents[3] / "data_pack" / "primary_2025_26"
NETWORK_FILE = DATA_PACK / "network_2025_26.json"
ASSUMPTIONS_FILE = DATA_PACK / "demo_assumptions.json"

FACILITY_IDS = ["OKHLA_WTE", "NARELA_BAWANA_INTEGRATED", "GHAZIPUR_WTE", "TEHKHAND_WTE"]
NODE_IDS = ["MCD", "NDMC", "DCB"]

ENV_COST_NOT_MODELLED_EVIDENCE = (
    "Facility-specific environmental cost is not modeled in this MVP; assumed Rs 0/tonne as an explicit "
    "placeholder distinguishing 'not modeled' from a real measured zero-cost finding. A real per-facility "
    "environmental cost would require emissions/externality pricing not available for FY2025-26 -- see "
    "engine/economics.py for the separate, explicitly MODELLED lifecycle-emissions calculation, which is "
    "not the same thing as this optimizer-facing per-tonne cost term."
)


def _field_from_json(d) -> Field:
    if d is None:
        return Field()
    return Field(
        State(d.get("state", "UNKNOWN")),
        d.get("value"),
        d.get("year"),
        tuple(d.get("provenance", [])),
        d.get("evidence", d.get("ev", "")),
    )


def _prefer(network_field: Field, assumed: Field, mode: str) -> Field:
    """Never let an assumption override a real value. If the network file already
    has something usable in this mode, use it; otherwise fall back to the
    assumption (demo mode only -- caller must not call this in validated mode)."""
    if network_field.usable(mode):
        return network_field
    return assumed


def _facility_field(network_raw_value, fid: str, assumption_map: dict, mode: str) -> Field:
    """Generic per-facility field resolver used for load and processing cost: reads
    whatever the network file states (possibly nothing today) as a Field, reads any
    DEMO assumption for this facility, and returns whichever _prefer() says wins.
    This is the live code path _prefer() actually runs through -- not dead code -- and
    is exercised directly by test_build_instance.py with a synthetic KNOWN network value."""
    network_field = _field_from_json(network_raw_value)
    assumed_field = Field()
    if mode == "demo" and fid in assumption_map:
        a = assumption_map[fid]
        assumed_field = assumption(a["value"], a["evidence"])
    return _prefer(network_field, assumed_field, mode)


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def load_raw():
    net = json.load(open(NETWORK_FILE))
    assum = json.load(open(ASSUMPTIONS_FILE)) if ASSUMPTIONS_FILE.exists() else {}
    return net, assum


def build_instance(mode: str = "validated", overrides: dict | None = None) -> Instance:
    """overrides: optional dict for scenario mutation, e.g.
    {"facility_status": {"GHAZIPUR_WTE": "outage"},
     "generation_multiplier": {"MCD": 1.3}}                 -- TOTAL_NETWORK surge: the
         WHOLE node's generation is scaled up, for use with capacity_mode="total_network".
     "generation_surge_fraction": {"MCD": 0.05}}            -- INCREMENTAL_SPARE surge: ONLY
         the incremental extra tonnage is modelled as new waste needing to be absorbed into
         spare capacity. ANY node without an explicit fraction here gets ZERO, not its full
         baseline -- see the incremental_mode branch below.
    Applied AFTER assumptions/network are loaded, so a scenario can flip an
    ASSUMED 'operating' status to 'outage', or scale a KNOWN generation figure,
    without touching the underlying data files."""
    overrides = overrides or {}
    net, assum = load_raw()

    # ---- source nodes ----
    supply = {}
    incremental_mode = "generation_surge_fraction" in overrides
    for nid, node in zip(NODE_IDS, net["source_nodes"]):
        assert node["id"] == nid
        gen = _field_from_json(node["generation_tpd"])
        if incremental_mode:
            frac = overrides["generation_surge_fraction"].get(nid)
            if frac is not None and gen.usable(mode):
                gen = Field(
                    State.DERIVED, gen.value * frac, gen.year, gen.provenance,
                    evidence=(
                        f"{gen.evidence} -- INCREMENTAL surge only: {frac:.0%} of baseline "
                        f"({gen.value:.0f} TPD) = {gen.value * frac:.1f} TPD modelled as NEW waste "
                        f"on top of already-assumed existing load; the baseline tonnage itself is not "
                        f"re-supplied here (see incremental_spare capacity semantics)."
                    ),
                )
            else:
                gen = Field(
                    State.DERIVED, 0.0,
                    evidence="INCREMENTAL_SPARE scenario: no surge specified for this node -- modelled "
                             "as zero incremental demand. Its baseline generation is not re-supplied here.",
                )
        else:
            mult = overrides.get("generation_multiplier", {}).get(nid)
            if mult is not None and gen.usable(mode):
                gen = Field(State.DERIVED, gen.value * mult, gen.year,
                            gen.provenance, evidence=f"{gen.evidence} x scenario multiplier {mult}")
        supply[nid] = gen

    # ---- facilities ----
    fac_status_assum = assum.get("facility_status", {})
    fac_load_assum = assum.get("facility_load_tpd", {})
    fac_cost_assum = assum.get("facility_processing_cost_rs_per_tonne", {})
    coords_assum = assum.get("coordinates", {})

    facilities = {}
    subset = net["facility_subset"]["nodes"]
    for fnode in subset:
        fid = fnode["id"]
        cap = _field_from_json(fnode["capacity_tpd"])
        status = fnode["status"]
        status_override = overrides.get("facility_status", {}).get(fid)
        if status_override:
            status = status_override
        elif status == "UNKNOWN" and mode == "demo" and fid in fac_status_assum:
            status = fac_status_assum[fid]["value"]  # status is a string, not numeric

        # load/cost: network value (if the snapshot ever states one) always wins over a
        # DEMO assumption -- see _facility_field/_prefer. fnode.get(...) is None today for
        # both, so this resolves to the assumption in demo mode, same as before, but now
        # through the same override-safe path the network would use if it gained real data.
        load_field = _facility_field(fnode.get("load_tpd"), fid, fac_load_assum, mode)
        load_override = overrides.get("facility_load_tpd", {}).get(fid)
        if load_override is not None:
            load_field = Field(State.ASSUMPTION if mode == "demo" else State.KNOWN,
                                load_override, evidence="scenario override")

        cost_field = _facility_field(fnode.get("proc_cost_rs_per_tonne"), fid, fac_cost_assum, mode)

        env_cost_field = assumption(0.0, ENV_COST_NOT_MODELLED_EVIDENCE) if mode == "demo" else Field()

        facilities[fid] = Facility(
            id=fid, capacity=cap, load=load_field, proc_cost=cost_field,
            env_cost=env_cost_field, status=status,
        )

    # candidate (BUILD/RETROFIT) projects, demo mode only
    if mode == "demo":
        budget_block = assum.get("budget_annual_rs", {})
        candidates = budget_block.get("candidate_projects_cost", {})
        cand_map = {
            "TEHKHAND_EXPANSION": "TEHKHAND_WTE",       # retrofit target
            "OKHLA_BIO_CNG": None,                       # new build, no existing node
            "GHAZIPUR_CBG": None,
        }
        for pid, proj in candidates.items():
            capex = assumption(proj["capex_annual_rs"], proj["evidence"])
            adds = _field_from_json(proj["adds_tpd"])
            target = cand_map.get(pid)
            if target and target in facilities:
                facilities[target].retrofit_cost_annual = capex
                facilities[target].retrofit_adds_tpd = adds
            else:
                facilities[pid] = Facility(
                    id=pid, capacity=Field(), load=Field(), proc_cost=Field(State.ASSUMPTION, 1500,
                        evidence="same flat WTE/processing cost placeholder as the subset facilities"),
                    env_cost=assumption(0.0, ENV_COST_NOT_MODELLED_EVIDENCE), status="candidate",
                    is_candidate=True, build_capex_annual=capex, build_cap_tpd=adds,
                )

    # ---- distances ----
    dist = {}
    if mode == "demo":
        method = assum.get("distance_km", {})
        circuity = method.get("circuity_factor_assumed", 1.0)
        for nid in NODE_IDS:
            nc = coords_assum.get(nid)
            for fid in facilities:
                fc = coords_assum.get(fid)
                if nc and fc:
                    km = haversine_km(nc["lat"], nc["lon"], fc["lat"], fc["lon"]) * circuity
                    dist[nid, fid] = assumption(
                        round(km, 2),
                        f"haversine between ASSUMED coordinates x circuity factor {circuity}; see coordinates/distance_km sections of demo_assumptions.json",
                    )
                else:
                    dist[nid, fid] = Field()
    else:
        for nid in NODE_IDS:
            for fid in facilities:
                dist[nid, fid] = Field()

    transport_rate = Field()
    landfill_cost = Field()
    landfill_env = Field()
    budget = Field()
    if mode == "demo":
        t = assum.get("transport_cost_rs_per_tonne_km", {})
        transport_rate = assumption(t["value"], t["evidence"])
        l = assum.get("landfill_cost_rs_per_tonne", {})
        landfill_cost = assumption(l["value"], l["evidence"])
        le = assum.get("landfill_env_cost_rs_per_tonne", {})
        landfill_env = assumption(le["value"], le["evidence"])
        b = assum.get("budget_annual_rs", {})
        if "value" in b:
            budget = assumption(b["value"], b["evidence"])

    city_cap = _field_from_json(net["city_reference_metrics"]["installed_capacity_tpd"])

    return Instance(
        supply=supply, facilities=facilities, dist_km=dist,
        transport_rs_tkm=transport_rate, landfill_cost=landfill_cost, landfill_env=landfill_env,
        budget_annual=budget, mode=mode, city_reference_capacity_tpd=city_cap,
    )
