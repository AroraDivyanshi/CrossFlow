"""CLI diagnostic: report every field in network_2025_26.json that is not
KNOWN/DERIVED (i.e. would block a VALIDATED-mode optimizer run)."""
import json
import sys
from pathlib import Path

from .model import Field, State


def _f(d):
    return Field(State(d.get("state", "UNKNOWN")), d.get("value"))


def missing_report(path):
    net = json.load(open(path))
    out = []
    for s in net["source_nodes"]:
        f = _f(s["generation_tpd"])
        if not f.usable("validated"):
            out.append((f"source {s['id']}.generation_tpd", f.state.value))
    for fc in net["facility_subset"]["nodes"]:
        if fc["status"] != "operating" and fc["status"] != "outage":
            out.append((f"facility {fc['id']}.status", fc["status"]))
        cap = _f(fc["capacity_tpd"])
        if not cap.usable("validated"):
            out.append((f"facility {fc['id']}.capacity_tpd", cap.state.value))
        out.append((f"facility {fc['id']}.load_tpd", "UNKNOWN (not in network file)"))
        out.append((f"facility {fc['id']}.proc_cost_rs_t", "UNKNOWN (not in network file)"))
        out.append((f"facility {fc['id']}.coords", "UNKNOWN (not in network file)"))
    out.append(("distances_km", "UNKNOWN (not in network file)"))
    out.append(("transport_rs_per_tkm", "UNKNOWN (not in network file)"))
    return out


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else str(
        Path(__file__).resolve().parents[3] / "data_pack" / "primary_2025_26" / "network_2025_26.json"
    )
    for name, st in missing_report(p):
        print(f"{st:45} {name}")
