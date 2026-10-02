/**
 * CrossFlow API client.
 *
 * Thin fetch() wrapper around the middle-layer HTTP API (localloop/backend/api/server.py).
 * No optimizer/scenario/economics logic lives here -- every function just calls an endpoint
 * and returns the parsed JSON (or throws with the server's own structured error body attached).
 *
 * Base URL is overridable via ?api=<url> in the page's own URL, or window.CROSSFLOW_API_BASE,
 * so the same static frontend can point at a locally-run API server on any port.
 */
(function (global) {
  const params = new URLSearchParams(location.search);
  const BASE = params.get("api") || global.CROSSFLOW_API_BASE || "http://localhost:8000/api";

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  async function getJSON(path) {
    let res;
    try {
      res = await fetch(BASE + path, { headers: { Accept: "application/json" } });
    } catch (networkErr) {
      throw new ApiError(
        `Could not reach the CrossFlow API at ${BASE}. Is the API server running ` +
          `(python3 -m api.server, from localloop/backend)?`,
        0,
        null
      );
    }
    let body = null;
    try {
      body = await res.json();
    } catch (parseErr) {
      // fall through with body=null; status check below still reports something useful
    }
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, body);
    }
    return body;
  }

  const CrossFlowAPI = {
    BASE,
    ApiError,
    health: () => getJSON("/health"),
    scenarios: () => getJSON("/scenarios"),
    network: () => getJSON("/network"),
    /**
     * @param {string} scenario - one of the ids returned by scenarios()
     * @param {{mode?: 'demo'|'validated', capacityMode?: 'total_network'|'incremental_spare'}} opts
     */
    pipeline: (scenario, opts = {}) => {
      const qs = new URLSearchParams();
      if (opts.mode) qs.set("mode", opts.mode);
      if (opts.capacityMode) qs.set("capacity_mode", opts.capacityMode);
      const q = qs.toString();
      return getJSON(`/pipeline/${encodeURIComponent(scenario)}${q ? "?" + q : ""}`);
    },
    /** @param {{organic_fraction?,moisture_pct?,contamination_pct?,cn_ratio?}} feedstock */
    recipe: (feedstock = {}) => {
      const qs = new URLSearchParams();
      Object.entries(feedstock).forEach(([k, v]) => {
        if (v !== undefined && v !== null) qs.set(k, v);
      });
      const q = qs.toString();
      return getJSON(`/recipe${q ? "?" + q : ""}`);
    },
  };

  global.CrossFlowAPI = CrossFlowAPI;
})(window);
