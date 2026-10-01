"""
Static geography/network metadata for the frontend map, read directly from the
frozen data files (network_2025_26.json, demo_assumptions.json). No coordinate,
status, or relationship here is invented -- every field carries the same
OBSERVED/DERIVED/ASSUMED/UNKNOWN state the backend itself assigned it, and a
missing value is returned as null, never guessed.

This module does not compute anything the optimizer computes -- it is a
read-only projection of the input data the pipeline consumes, for the
frontend's map/legend before a scenario is even run. Scenario-dependent
facility status, flows and allocation come from /api/pipeline/<scenario>,
not from here (see server.py).
"""
import json
from pathlib import Path

from engine.build_instance import ASSUMPTIONS_FILE, NETWORK_FILE

# Display labels are cosmetic only (for a legible map/legend) -- they do not
# change, override, or stand in for any backend field or value.
DISPLAY_NAMES = {
    "MCD": "Municipal Corporation of Delhi",
    "NDMC": "New Delhi Municipal Council",
    "DCB": "Delhi Cantonment Board",
    "OKHLA_WTE": "Okhla Waste-to-Energy Plant",
    "NARELA_BAWANA_INTEGRATED": "Narela-Bawana Integrated Facility",
    "GHAZIPUR_WTE": "Ghazipur Waste-to-Energy Plant",
    "TEHKHAND_WTE": "Tehkhand Waste-to-Energy Plant",
    "OKHLA_BIO_CNG": "Okhla Bio-CNG (proposed)",
    "GHAZIPUR_CBG": "Ghazipur CBG (proposed)",
    "DECENTRALISED_COMPOST": "Decentralised Composters & Pits (citywide, no single site)",
}


def _coord(coords_assum, fid):
    c = coords_assum.get(fid)
    if not c:
        return None
    return {"lat": c["lat"], "lon": c["lon"], "state": c["state"], "evidence": c["evidence"]}


def get_network_geo() -> dict:
    net = json.load(open(NETWORK_FILE))
    assum = json.load(open(ASSUMPTIONS_FILE)) if Path(ASSUMPTIONS_FILE).exists() else {}
    coords_assum = assum.get("coordinates", {})

    source_nodes = []
    for n in net["source_nodes"]:
        source_nodes.append({
            "id": n["id"],
            "display_name": DISPLAY_NAMES.get(n["id"], n["id"]),
            "kind": "source_node",
            "generation_tpd": n["generation_tpd"],
            "coordinates": _coord(coords_assum, n["id"]),
        })

    facilities = []
    for f in net["facility_subset"]["nodes"]:
        facilities.append({
            "id": f["id"],
            "display_name": DISPLAY_NAMES.get(f["id"], f["id"]),
            "kind": "facility",
            "technology": f.get("technology"),
            "capacity_tpd": f["capacity_tpd"],
            "status_in_network_snapshot": f["status"],
            "coordinates": _coord(coords_assum, f["id"]),
            "note": "status_in_network_snapshot reflects the frozen data file only; a scenario's actual "
                    "resolved status/flows/allocation come from GET /api/pipeline/<scenario>.",
        })

    candidates = []
    for pid in ("TEHKHAND_EXPANSION", "OKHLA_BIO_CNG", "GHAZIPUR_CBG"):
        proj = assum.get("budget_annual_rs", {}).get("candidate_projects_cost", {}).get(pid)
        if not proj:
            continue
        coord_key = "TEHKHAND_WTE" if pid == "TEHKHAND_EXPANSION" else pid
        candidates.append({
            "id": pid,
            "display_name": DISPLAY_NAMES.get(pid, pid),
            "kind": "candidate_project",
            "action": "RETROFIT" if pid == "TEHKHAND_EXPANSION" else "BUILD",
            "adds_tpd": proj["adds_tpd"],
            "coordinates": _coord(coords_assum, coord_key),
        })

    edges = [{"from": n["id"], "to": f["id"]} for n in net["source_nodes"] for f in net["facility_subset"]["nodes"]]

    return {
        "source_nodes": source_nodes,
        "facilities": facilities,
        "candidate_projects": candidates,
        "network_relationships": {
            "description": "The current model is fully connected: every source_node can route to every "
                            "facility in `facilities` above (no route restrictions are encoded). Distances "
                            "between them are ASSUMED (haversine between ASSUMED coordinates x a circuity "
                            "factor) -- see /api/pipeline/<scenario> optimizer_result.flow_assumption_ids "
                            "for which specific values were ASSUMED for a given flow.",
            "edges": edges,
        },
        "coordinate_caveat": coords_assum.get(
            "_evidence", "Coordinates are ASSUMED (locality-level), not an official facility register."
        ),
    }
