"""
Thin HTTP API around engine.pipeline.run_pipeline(). No optimizer, scenario,
economics, or explanation logic is duplicated here -- every route either
reads a static data file directly (geo.py) or calls straight into the frozen
backend and serializes whatever it returns (serialize.py).

Built on Python's stdlib http.server rather than FastAPI/uvicorn because this
environment has no outbound network access to install either -- see
localloop/backend/FREEZE_REPORT.md for the same constraint noted during the
backend freeze. If FastAPI becomes available later, this module's ROUTES table
and handler functions can be ported directly; the routing logic here is
intentionally minimal (exact-path and prefix matching only) so that port is
mechanical, not a rewrite.

Endpoints:
  GET /api/health
  GET /api/scenarios
  GET /api/network
  GET /api/pipeline/<scenario_name>?mode=demo|validated&capacity_mode=...
"""
import json
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from engine import recipe as recipe_engine
from engine.model import MissingDataError
from engine.pipeline import run_pipeline
from engine.scenarios import SCENARIOS

from .geo import get_network_geo
from .serialize import to_jsonable

API_VERSION = "1.0.0"


def _scenarios_metadata():
    return {
        name: {
            "name": name,
            "description": spec["description"],
            "capacity_mode": spec["capacity_mode"],
            "overrides_applied": spec["overrides"],
        }
        for name, spec in SCENARIOS.items()
    }


def _health():
    return 200, {
        "status": "ok",
        "api_version": API_VERSION,
        "backend": "frozen (see localloop/backend/FREEZE_REPORT.md)",
        "available_scenarios": list(SCENARIOS.keys()),
    }


def _scenarios():
    return 200, {"scenarios": _scenarios_metadata()}


def _network():
    try:
        return 200, get_network_geo()
    except Exception as e:  # noqa: BLE001 -- surfaced to the client deliberately, see error shape below
        return 500, {"error": "network_geo_failed", "message": str(e)}


FEEDSTOCK_FIELDS = {
    "organic_fraction": (0.0, 1.0),
    "moisture_pct": (0.0, 100.0),
    "contamination_pct": (0.0, 100.0),
    "cn_ratio": (0.0, 200.0),
    "dry_combustible_fraction": (0.0, 1.0),  # only meaningful if independently supplied -- see recipe.py
}


def _recipe(query):
    """Thin wrapper around engine.recipe.evaluate() -- no scoring/threshold logic lives here.
    Accepts any subset of FEEDSTOCK_FIELDS as query params; omitted fields are simply not
    evaluated by the recipe engine (same behaviour as calling it with a partial dict directly)."""
    feedstock = {}
    for field, (lo, hi) in FEEDSTOCK_FIELDS.items():
        if field in query:
            raw = query[field][0]
            try:
                value = float(raw)
            except ValueError:
                return 400, {"error": "invalid_feedstock_value", "field": field, "got": raw,
                              "message": f"{field} must be a number"}
            if not (lo <= value <= hi):
                return 400, {"error": "feedstock_value_out_of_range", "field": field, "got": value,
                              "message": f"{field} must be between {lo} and {hi}"}
            feedstock[field] = value
    try:
        result = recipe_engine.evaluate(feedstock)
        return 200, {"feedstock_submitted": feedstock, "advisory_note": (
            "Processing compatibility advisory: this result does not constrain or override any "
            "optimizer allocation -- see engine.pipeline.RECIPE_INTEGRATION_STATUS."
        ), **to_jsonable(result)}
    except Exception as e:  # noqa: BLE001
        return 500, {"error": "recipe_failed", "message": str(e)}


def _pipeline(scenario_name, query):
    if scenario_name not in SCENARIOS:
        return 404, {"error": "unknown_scenario", "scenario": scenario_name,
                      "available_scenarios": list(SCENARIOS.keys())}
    mode = query.get("mode", ["demo"])[0]
    if mode not in ("demo", "validated"):
        return 400, {"error": "invalid_mode", "message": "mode must be 'demo' or 'validated'", "got": mode}
    capacity_mode_q = query.get("capacity_mode", [None])[0]
    if capacity_mode_q not in (None, "total_network", "incremental_spare"):
        return 400, {"error": "invalid_capacity_mode",
                      "message": "capacity_mode must be 'total_network' or 'incremental_spare' if provided",
                      "got": capacity_mode_q}
    try:
        result = run_pipeline(scenario_name, mode=mode, capacity_mode=capacity_mode_q)
        return 200, to_jsonable(result)
    except MissingDataError as e:
        # Honest, structured failure -- e.g. mode="validated" genuinely cannot complete yet.
        # This is the backend's own contract (see FREEZE_REPORT.md), not an API bug.
        return 422, {"error": "missing_data", "message": str(e), "scenario": scenario_name, "mode": mode}
    except Exception as e:  # noqa: BLE001
        return 500, {"error": "pipeline_failed", "message": str(e),
                      "trace": traceback.format_exc().splitlines()[-5:]}


ROUTES = [
    ("GET", "/api/health", lambda path_parts, query: _health()),
    ("GET", "/api/scenarios", lambda path_parts, query: _scenarios()),
    ("GET", "/api/network", lambda path_parts, query: _network()),
    ("GET", "/api/recipe", lambda path_parts, query: _recipe(query)),
    ("GET", "/api/pipeline/", lambda path_parts, query: _pipeline(path_parts[0] if path_parts else "", query)),
]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        path = parsed.path

        for method, prefix, handler in ROUTES:
            if method != "GET":
                continue
            if prefix.endswith("/") and path.startswith(prefix):
                remainder = path[len(prefix):].strip("/")
                path_parts = remainder.split("/") if remainder else []
                status, body = handler(path_parts, query)
                self._respond(status, body)
                return
            if path == prefix:
                status, body = handler([], query)
                self._respond(status, body)
                return

        self._respond(404, {"error": "not_found", "path": path,
                             "available_endpoints": [p for _, p, _ in ROUTES]})

    def _respond(self, status, body):
        payload = json.dumps(body, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        sys.stderr.write("[api] " + (fmt % args) + "\n")


def run(port=8000):
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"CrossFlow API listening on http://0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run(port)
