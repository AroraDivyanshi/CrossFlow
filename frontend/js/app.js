/**
 * CrossFlow frontend application logic.
 *
 * Uses only the live CrossFlow API for analytical values. This file is presentation-only:
 * it translates backend codes, performs display arithmetic, and renders compact visual summaries.
 * No optimizer, recipe, scenario, economics, or output-matching logic is duplicated here.
 *
 * Flow:  init() -> /api/scenarios + /api/network -> prefetch all scenarios (hero strip)
 *        -> runScenario(initial) -> /api/pipeline/<id> -> renderMain() -> refreshMapLiveData()
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Label tables (presentation only)
  // ---------------------------------------------------------------------------

  const SCENARIO_LABELS = {
    baseline: "Baseline",
    ghazipur_outage: "Ghazipur outage",
    festival_surge_mcd_20pct: "Festival +20%",
    monsoon_surge_30pct: "Monsoon +30%",
    spare_capacity_demo: "Spare capacity",
  };

  const DECISION_ICON = { BUILD: "✦", RETROFIT: "⚙", REROUTE: "↻", DO_NOTHING: "●" };

  const DECISIONS = {
    BUILD: { label: "Build", sub: "Add new capacity" },
    RETROFIT: { label: "Retrofit", sub: "Upgrade existing capacity" },
    REROUTE: { label: "Reroute", sub: "Change the allocation" },
    DO_NOTHING: { label: "Hold", sub: "Keep the current allocation" },
  };

  const CAPACITY_MODES = {
    total_network: { label: "Total network", sub: "Whole network against installed/nameplate capacity" },
    incremental_spare: { label: "Incremental spare", sub: "Additional waste against spare capacity" },
  };

  const PROVENANCE = {
    OBSERVED: "Reported", DERIVED: "Derived", ASSUMED: "Assumed", ASSUMPTION: "Assumed", MODELLED: "Modelled",
  };

  const METHOD_LABELS = {
    composting: "Composting", biomethanation: "Biomethanation", waste_to_energy: "Waste-to-energy", rdf: "RDF",
  };

  const OUTPUT_LABELS = {
    power_mwh: { name: "Recovered power", unit: "MWh/day", icon: "⚡" },
    compost_tonnes: { name: "Compost", unit: "t/day", icon: "🌱" },
  };

  // Short names + colours for compact dashboard use (display only)
  const SHORT_NAMES = {
    MCD: "MCD", NDMC: "NDMC", DCB: "DCB",
    OKHLA_WTE: "Okhla WTE", NARELA_BAWANA_INTEGRATED: "Narela-Bawana",
    GHAZIPUR_WTE: "Ghazipur WTE", TEHKHAND_WTE: "Tehkhand WTE",
    OKHLA_BIO_CNG: "Okhla Bio-CNG", GHAZIPUR_CBG: "Ghazipur CBG",
    DECENTRALISED_COMPOST: "Decentralised compost",
    DISCOM_GRID: "DISCOM grid", MCD_PARKS_HORTICULTURE: "MCD parks",
  };

  const FAC_COLORS = {
    OKHLA_WTE: "#159b83",
    NARELA_BAWANA_INTEGRATED: "#60aeda",
    GHAZIPUR_WTE: "#b9df58",
    TEHKHAND_WTE: "#8d7bd8",
    DECENTRALISED_COMPOST: "#7bbf6a",
  };
  const LANDFILL_COLOR = "#e98258";

  const STATUS_COLORS = {
    steady: "#2563eb", rerouted: "#f59e0b", offline: "#ef4444", built: "#16a34a", retrofit: "#a855f7",
  };

  const REASONS = {
    LOWEST_MODELED_LANDED_COST: ["Lowest modelled cost", "This route has the lowest modelled landed cost."],
    SHORTEST_MODELED_ROUTE_DISTANCE: ["Shortest route", "This is the shortest modelled route from the source."],
    CAPACITY_BINDING_AT_DESTINATION: ["Facility full", "This facility is at its modelled capacity."],
    LOWER_MODELED_COST_OPTION_UNAVAILABLE: ["Cheaper option unavailable", null],
    LOWER_MODELED_COST_OPTION_CAPACITY_BINDING: ["Cheaper option full", null],
    LOWER_MODELED_COST_OPTION_NOT_SELECTED_BY_SOLVER: ["Cheaper option not chosen", null],
    ALL_OPERATING_FACILITY_CAPACITY_EXHAUSTED: ["All capacity used", "Operating facility capacity is exhausted."],
    RESIDUAL_ALLOCATION_TO_LANDFILL: ["Residual to landfill", "This remainder was not assigned to a more suitable destination."],
    OUTAGE_CAUSED_REROUTE: ["Rerouted by outage", null],
    ALLOCATION_CHANGED_DUE_TO_SCENARIO_INPUT_CHANGE: ["Allocation changed", "Waste generation changed under this scenario."],
    NO_CHANGE_FROM_BASELINE_ALLOCATION: ["No change", "This facility keeps its baseline allocation."],
    CAPACITY_BINDING: ["At capacity", "This facility is at its modelled capacity."],
    BUILD_CHOSEN_WITHIN_BUDGET: ["Build chosen", null],
    RETROFIT_CHOSEN_WITHIN_BUDGET: ["Retrofit chosen", null],
  };

  const RECIPE_PRESETS = {
    mixed: { label: "Mixed MSW", organic_fraction: 0.4, moisture_pct: 55, contamination_pct: 12, cn_ratio: 28 },
    wet: { label: "Wet organics", organic_fraction: 0.72, moisture_pct: 68, contamination_pct: 6, cn_ratio: 24 },
    dry: { label: "Dry recoverables", organic_fraction: 0.22, moisture_pct: 18, contamination_pct: 15, cn_ratio: 55 },
    highmoisture: { label: "Surge mix", organic_fraction: 0.45, moisture_pct: 78, contamination_pct: 14, cn_ratio: 30 },
  };

  const FEEDSTOCK_LABELS = {
    organic_fraction: ["Organic", (v) => Math.round(v * 100) + "%"],
    moisture_pct: ["Moisture", (v) => v + "%"],
    contamination_pct: ["Contamination", (v) => v + "%"],
    cn_ratio: ["C:N", (v) => v + ":1"],
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let facilityNames = {};
  let network = null;
  let heroCache = {};          // scenario id -> result at the scenario's NATURAL capacity mode (hero strip / pulse)
  let resultCache = {};        // "scenario|capacity_mode" -> result (any mode the user has run)
  let lastResult = null;
  let lastScenarioId = null;
  let lastRecipe = null;
  let scenarioDefaults = {};   // scenario id -> natural capacity_mode, from /api/scenarios
  let scenarioOverrides = {};  // scenario id -> overrides_applied, from /api/scenarios
  let mapMarkers = {};         // node id -> { marker, node, kind }
  let nodeCoords = {};         // node id -> [lat, lon]
  let flowLayer = null;
  let flowLines = [];          // { line, src, dst }
  let selectedNodeId = null;
  let runSeq = 0;              // guards against out-of-order responses

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const sum = (arr) => arr.reduce((a, b) => a + Number(b || 0), 0);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function fmt(value, digits = 1) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function formatCompact(value) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  // quantity formatter for stat tiles: compact for big numbers, 1 decimal for small ones
  function fmtQ(value) {
    if (value == null || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    if (Math.abs(n) >= 10000) return formatCompact(n);
    return fmt(n, Math.abs(n) < 100 ? 1 : 0);
  }

  function pct(n) {
    return Math.max(0, Math.min(100, Number(n) || 0));
  }

  function prettyId(value) {
    if (!value) return "—";
    return String(value).replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function displayName(id) {
    return facilityNames[id] || prettyId(id);
  }

  function shortName(id) {
    return SHORT_NAMES[id] || displayName(id);
  }

  function colorOf(id) {
    return FAC_COLORS[id] || "#8aa79b";
  }

  function modeInfo(mode) {
    return CAPACITY_MODES[mode] || { label: prettyId(mode), sub: "" };
  }

  function titleCaseDecision(decision) {
    return DECISIONS[decision]?.label || prettyId(decision);
  }

  function pickHeadline(decisions = {}) {
    const entries = Object.entries(decisions);
    if (!entries.length) return { fid: null, decision: null, allStable: false };
    const changed = entries.find(([, d]) => d !== "DO_NOTHING");
    const [fid, decision] = changed || entries[0];
    return { fid, decision, allStable: entries.every(([, d]) => d === "DO_NOTHING") };
  }

  // backend reasons embed Python lists like ['GHAZIPUR_WTE'] -- show readable names instead
  function sanitizeIds(text) {
    return String(text || "").replace(/\[([^\]]*)\]/g, (m, inner) =>
      inner.split(",").map((x) => x.replace(/['"\s]/g, "")).filter(Boolean).map((id) => shortName(id)).join(", "));
  }

  function humanizeReason(raw) {
    const original = String(raw || "");
    const match = original.match(/^([A-Z][A-Z_]+)/);
    const code = match ? match[1] : "";
    const str = sanitizeIds(original);
    const entry = REASONS[code];
    if (!entry) {
      return { title: prettyId(code) || "Reason", text: str.slice(code.length).replace(/^[:\s]+/, "") };
    }
    const colon = str.indexOf(":");
    const detail = colon >= 0 ? str.slice(colon + 1).trim() : "";
    return { title: entry[0], text: entry[1] || detail || entry[0] };
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function setStatus(message, ok = true) {
    const dot = document.querySelector(".status .dot");
    const label = $("apiStatusText");
    if (dot) dot.classList.toggle("offline", !ok);
    if (label) label.textContent = message;
  }

  // Blank every value that came from a previous run so an error never leaves stale numbers on screen.
  function clearKpis() {
    ["throughput", "landfill", "diversion", "power", "emissions", "landfillPressure", "divertedBar", "heroDiversion",
      "throughputProcessed", "throughputLandfilled"].forEach((id) => setText(id, "—"));
    setText("landfillState", "N/A");
    setText("diversionState", "N/A");
    setText("powerState", "N/A");
    ["pressureFill", "divertedFill", "landfillFill", "tpProcessedBar", "tpLandfillBar"].forEach((id) => {
      const n = $(id);
      if (n) n.style.width = "0%";
    });
    const powerFill = $("powerFill");
    if (powerFill) powerFill.style.setProperty("--power-width", "0%");
    const ring = $("diversionRing");
    if (ring) {
      ring.style.background = "conic-gradient(var(--teal) 0 0%, #e6eee9 0% 100%)";
      const label = ring.querySelector("span");
      if (label) label.textContent = "—";
    }
  }

  function showConnectionError(err) {
    setStatus("⚠ API offline", false);
    setText("decisionTitle", "Can't reach the CrossFlow API");
    setText("decisionText", err?.message || "Start the API server from localloop/backend and reload.");
    const reasonLine = $("reasonLine");
    if (reasonLine) reasonLine.innerHTML = '<span class="reason">NO CONNECTION</span>';
    clearKpis();
  }

  // Facility state for the current run. Uses scenario overrides from /api/scenarios to tell a
  // true outage apart from "spare capacity is simply zero".
  function facilityLiveStatus(fid, result = lastResult) {
    const r = result?.optimizer_result;
    if (!r || r.status !== "Optimal") return null;
    const allocatedRaw = r.tonnes_allocated_tpd?.[fid];
    const baseRaw = r.base_capacity_tpd?.[fid];
    if (allocatedRaw === undefined && baseRaw === undefined) return null;
    const allocated = allocatedRaw === undefined ? null : Number(allocatedRaw);
    const base = baseRaw === undefined ? null : Number(baseRaw);
    const decision = result.decisions?.[fid] || null;
    const binding = (r.capacity_binding || []).includes(fid);
    const declaredOutage = scenarioOverrides[result.scenario]?.facility_status?.[fid] === "outage";
    const fallbackOutage =
      !scenarioOverrides[result.scenario] && result.capacity_mode === "total_network" && base === 0 && allocated === 0;
    const mk = (key, label) => ({ key, label, color: STATUS_COLORS[key], decision, allocated, base, binding });
    if (declaredOutage || fallbackOutage) return mk("offline", "Offline");
    if (decision === "BUILD") return mk("built", "Built");
    if (decision === "RETROFIT") return mk("retrofit", "Retrofitted");
    if (decision === "REROUTE") return mk("rerouted", "Rerouted");
    return mk("steady", "Steady");
  }

  function sourceLiveInfo(nid, result = lastResult) {
    const r = result?.optimizer_result;
    if (!r || r.status !== "Optimal") return null;
    const landfilled = Number(r.landfilled_tpd?.[nid] ?? 0);
    const parts = [];
    Object.entries(r.flows_tpd || {}).forEach(([key, val]) => {
      const [s, d] = key.split("->");
      if (s === nid && Number(val) > 0) parts.push({ id: d, tpd: Number(val) });
    });
    return { routed: sum(parts.map((p) => p.tpd)), landfilled, parts };
  }

  // ---------------------------------------------------------------------------
  // Styles (injected once)
  // ---------------------------------------------------------------------------

  const CF_CSS = `
    .cf-clean{margin-top:16px}

    /* ---------- decision chain ---------- */
    .cf-chainbar{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
    .cf-chainitem{position:relative;padding:13px 15px;background:#fff;border:1px solid var(--line);border-radius:18px;min-width:0;box-shadow:0 8px 20px rgba(31,70,55,.04)}
    .cf-chainitem:not(:last-child)::after{content:'→';position:absolute;right:-10px;top:50%;transform:translateY(-50%);color:#95a89f;font-weight:900;background:var(--bg);padding:0 2px;z-index:2;font-size:12px}
    .cf-chainitem small{display:block;font-size:8px;letter-spacing:.11em;text-transform:uppercase;color:#8a9b93;font-weight:900}
    .cf-chainitem b{display:block;margin-top:5px;font-size:15px;line-height:1.15;color:var(--teal-dark);letter-spacing:-.02em}
    .cf-chainitem span{display:block;margin-top:4px;font-size:9px;color:#70857b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    /* ---------- dashboard grid / panels ---------- */
    .cf-dashboard-grid{display:grid;grid-template-columns:.95fr 1.05fr;gap:14px;align-items:start}
    .cf-left-stack{display:grid;gap:14px;min-width:0;align-content:start}
    .cf-panel{background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px;min-width:0;box-shadow:0 10px 25px rgba(31,70,55,.045)}
    .cf-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .cf-panel-head h4{margin:0;font-size:16px;line-height:1.2;letter-spacing:-.025em}
    .cf-panel-head p{margin:4px 0 0;font-size:9.5px;line-height:1.45;color:#71857b}
    .cf-pill{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:999px;background:#eef7f2;border:1px solid #d4e8df;color:var(--teal-dark);font-size:8px;font-weight:900;letter-spacing:.06em;white-space:nowrap;text-transform:uppercase}
    .cf-sec{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 6px;font-size:8px;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:#8a9b93}
    .cf-foot{margin-top:12px;padding-top:10px;border-top:1px solid #e9efec;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:8.5px;line-height:1.4;color:#7a8d84}

    /* badges */
    .cf-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:999px;font-size:8px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;border:1px solid transparent}
    .cf-badge.ok{background:#e9f8f3;color:#0d7463;border-color:#cce9df}
    .cf-badge.full{background:#fff0e9;color:#c0501f;border-color:#f2c9b6}
    .cf-badge.warn{background:#fff6df;color:#a8721a;border-color:#f1ddb0}
    .cf-badge.off{background:#fff0f2;color:#c23a4e;border-color:#f1c6ce}
    .cf-badge.info{background:#edf3ff;color:#2f55c4;border-color:#d1dcf7}
    .cf-badge.build{background:#e8f8ec;color:#177a3b;border-color:#c5e8d0}
    .cf-badge.retrofit{background:#f3ecfd;color:#7a3fc0;border-color:#e0d0f5}
    .cf-badge.neutral{background:#f3f7f5;color:#60766b;border-color:#e1ebe6}
    .cf-delta{font-size:8.5px;font-weight:900;padding:2px 6px;border-radius:6px;background:#fff6df;color:#a8721a}
    .cf-delta.down{background:#eef3fb;color:#3b5a9c}

    /* ---------- capacity ---------- */
    .cf-cap-hero{display:grid;grid-template-columns:104px 1fr;gap:14px;align-items:center;margin-top:14px}
    .cf-ring{--p:0%;--c:var(--teal);position:relative;width:104px;height:104px;border-radius:50%;background:conic-gradient(var(--c) 0 var(--p),#e4ede8 var(--p) 100%);display:grid;place-items:center;transition:background .4s}
    .cf-ring::before{content:"";position:absolute;inset:10px;border-radius:50%;background:#fff}
    .cf-ring div{position:relative;text-align:center}
    .cf-ring b{display:block;font-size:24px;letter-spacing:-.05em;line-height:1;color:var(--ink)}
    .cf-ring small{display:block;margin-top:3px;font-size:7px;letter-spacing:.1em;text-transform:uppercase;color:#80938a;font-weight:900}
    .cf-mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
    .cf-mini{padding:8px 10px;border:1px solid #e1ebe6;border-radius:12px;background:#f9fcfa;min-width:0}
    .cf-mini span{display:block;font-size:7.5px;color:#85978f;text-transform:uppercase;letter-spacing:.09em;font-weight:900}
    .cf-mini b{display:block;margin-top:3px;font-size:18px;letter-spacing:-.04em;color:var(--ink);line-height:1.1}
    .cf-mini b em{font-style:normal;font-size:8.5px;font-weight:800;color:#84958e;margin-left:3px;letter-spacing:0}
    .cf-mini.accent b{color:var(--teal-dark)}
    .cf-mini.warn{background:#fff8ee;border-color:#f3dfbd}.cf-mini.warn b{color:#c0651f}

    .cf-bar{height:9px;border-radius:999px;overflow:hidden;background:#e8efeb;display:flex}
    .cf-bar i{display:block;height:100%;transition:width .5s cubic-bezier(.22,.75,.18,1)}
    .cf-bar .used{background:linear-gradient(90deg,var(--teal),#73ceb6)}
    .cf-bar .free{background:#deefe7}
    .cf-bar .load{background:repeating-linear-gradient(45deg,#c5d1ca,#c5d1ca 4px,#d5dfda 4px,#d5dfda 8px)}
    .cf-bar.full .used{background:linear-gradient(90deg,#e98258,#f1bb57)}
    .cf-bar.off{background:repeating-linear-gradient(45deg,#f4d5da,#f4d5da 4px,#fae6e9 4px,#fae6e9 8px)}
    .cf-bar.total{height:12px}
    .cf-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:7px;font-size:8.5px;color:#74867e}
    .cf-legend span{display:inline-flex;align-items:center;gap:5px}
    .cf-legend i{width:8px;height:8px;border-radius:3px;display:inline-block}
    .cf-legend .sw-used{background:var(--teal)}.cf-legend .sw-free{background:#cfe6dc}
    .cf-legend .sw-load{background:repeating-linear-gradient(45deg,#c0ccc5,#c0ccc5 2px,#dde5e0 2px,#dde5e0 4px)}
    .cf-legend .sw-lf{background:#e98258}

    .cf-fac-row{display:grid;grid-template-columns:122px minmax(60px,1fr) 140px;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #edf2ef}
    .cf-fac-row:first-of-type{border-top:0}
    .cf-fac-name{display:flex;align-items:center;gap:6px;min-width:0}
    .cf-fac-name i{width:8px;height:8px;border-radius:3px;flex:none}
    .cf-fac-name b{font-size:10.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cf-fac-bar small{display:block;margin-top:4px;font-size:8px;color:#84958e}
    .cf-fac-val{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
    .cf-fac-val b{font-size:10px;color:var(--ink);white-space:nowrap}
    .cf-fac-val b em{font-style:normal;color:#8a9b93;font-weight:700}

    /* ---------- why this move ---------- */
    .cf-why-top{display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:center;margin-top:14px}
    .cf-why-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:#eef8f3;border:1px solid #d1e8de;color:var(--teal-dark);font-size:18px;font-weight:900}
    .cf-why-title b{display:block;font-size:14px;line-height:1.2;letter-spacing:-.02em}
    .cf-why-title span{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
    .cf-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
    .cf-step{position:relative;padding:10px 11px;border:1px solid #e1ebe6;border-radius:14px;background:#fbfdfc;min-width:0}
    .cf-step:not(:last-child)::after{content:"";position:absolute;right:-11px;top:50%;width:11px;height:2px;background:#cfe2d9}
    .cf-step-k{display:flex;align-items:center;gap:6px;font-size:7.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:900;color:#8a9b93}
    .cf-step-k i{width:18px;height:18px;border-radius:6px;background:var(--mint);color:var(--teal-dark);display:grid;place-items:center;font-style:normal;font-size:10px}
    .cf-step.warn .cf-step-k i{background:#fff0e9;color:#c0501f}
    .cf-step b{display:block;margin-top:7px;font-size:11px;color:var(--ink);line-height:1.2}
    .cf-step span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;font-size:8.5px;line-height:1.4;color:#788b82}
    .cf-route-row{display:grid;grid-template-columns:62px 1fr 62px;gap:9px;align-items:center;padding:5px 0}
    .cf-route-row b{font-size:10px;color:var(--ink)}
    .cf-route-row small{font-size:8.5px;color:#84958e;text-align:right;white-space:nowrap}
    .cf-stack{display:flex;height:12px;border-radius:999px;overflow:hidden;background:#e8efeb;gap:1px}
    .cf-stack i{display:block;height:100%;min-width:2px}
    .cf-stack.empty{background:repeating-linear-gradient(45deg,#e4ebe7,#e4ebe7 4px,#eef3f0 4px,#eef3f0 8px)}
    .cf-dchips{display:flex;flex-wrap:wrap;gap:6px}
    .cf-dchip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px 4px 6px;border-radius:999px;border:1px solid #e1ebe6;background:#fff;font-size:8.5px;color:#4f685d;font-weight:800}
    .cf-dchip i{width:8px;height:8px;border-radius:3px}
    .cf-dchip em{font-style:normal;font-weight:900;color:var(--teal-dark);text-transform:uppercase;letter-spacing:.05em;font-size:7.5px}
    .cf-dchip.REROUTE em{color:#a8721a}.cf-dchip.BUILD em{color:#177a3b}.cf-dchip.RETROFIT em{color:#7a3fc0}

    /* ---------- output matching ---------- */
    .cf-out-card{margin-top:12px;padding:12px;border:1px solid #e3ece7;border-radius:16px;background:#fbfdfc}
    .cf-out-card:first-of-type{margin-top:14px}
    .cf-out-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .cf-out-head b{display:flex;align-items:center;gap:8px;font-size:12.5px;letter-spacing:-.02em}
    .cf-out-head b i{width:26px;height:26px;border-radius:9px;background:var(--mint);display:grid;place-items:center;font-style:normal;font-size:13px}
    .cf-pipe{display:grid;grid-template-columns:1fr 14px 1fr 14px 1fr;gap:4px;align-items:stretch;margin-top:11px}
    .cf-pipe-arrow{display:grid;place-items:center;color:#95a89f;font-size:11px}
    .cf-tile{padding:8px 10px;border:1px solid #e0ebe6;border-radius:12px;background:#fff;min-width:0}
    .cf-tile span{display:block;font-size:7.5px;text-transform:uppercase;letter-spacing:.09em;color:#81938b;font-weight:900}
    .cf-tile b{display:block;margin-top:3px;font-size:19px;letter-spacing:-.04em;color:var(--ink);line-height:1.1}
    .cf-tile small{display:block;margin-top:2px;font-size:7.5px;color:#84958d}
    .cf-tile.hl{background:linear-gradient(145deg,#eef9f4,#f8fcfa);border-color:#cfe8dd}
    .cf-tile.hl b{color:var(--teal-dark)}
    .cf-meters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}
    .cf-meter-head{display:flex;justify-content:space-between;align-items:baseline;color:#71857b;font-size:8.5px;font-weight:700}
    .cf-meter-head b{font-size:11px;color:var(--teal-dark)}
    .cf-meter-head b.alt{color:#3f6f9c}
    .cf-track{height:8px;border-radius:999px;background:#e5ece8;overflow:hidden;margin-top:5px}
    .cf-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--teal),#75ceb6);transition:width .5s ease}
    .cf-track i.alt{background:linear-gradient(90deg,#7ea8c8,#4b78a5)}
    .cf-ledger{display:grid;gap:6px;margin-top:10px}
    .cf-match{display:grid;grid-template-columns:minmax(0,1fr) 14px minmax(0,1fr) 78px;gap:6px;align-items:center;padding:7px 9px;border:1px solid #e2ebe7;border-radius:11px;background:#fff}
    .cf-chip-node{display:flex;align-items:center;gap:6px;min-width:0}
    .cf-chip-node i{width:8px;height:8px;border-radius:3px;flex:none}
    .cf-chip-node b{font-size:9.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cf-match-arrow{text-align:center;color:#8ca198;font-size:11px}
    .cf-match-qty{text-align:right}
    .cf-match-qty b{display:block;font-size:10px;color:var(--teal-dark)}
    .cf-match-qty .cf-track{height:4px;margin-top:3px}
    .cf-remains{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
    .cf-remain{padding:4px 8px;border:1px solid #e1e9e5;border-radius:999px;background:#fff;font-size:8.5px;color:#71837b}
    .cf-remain b{color:var(--ink)}
    .cf-remain.good{background:#eef8f3;border-color:#d4e8df;color:#0d7463}

    /* ---------- recipe ---------- */
    .recipe{margin-top:15px}
    .recipe-title h3{font-size:21px}
    .recipe-title p{font-size:9.5px;max-width:680px}
    .recipe-stage{gap:12px}
    .recipe-journey{padding:17px}
    .journey-title{font-size:18px}
    .j-node{min-height:78px}
    .j-node b{font-size:8px}
    .j-node span{font-size:7px}
    .factor{padding:13px}
    .factor-head{font-size:9px}
    .factor-head b{font-size:12px}
    .factor small{font-size:7.5px}
    .recipe-side{padding:22px}
    .recipe-side .mini-label{font-size:7.5px}
    .verdict b{font-size:16px}
    .recipe-side h4{font-size:8px}
    .recipe-side p{font-size:9.5px}
    .compat span{font-size:7.5px}
    .recipe-note{font-size:7.5px}
    .recipe-insight,#limitingTitle,#limitingText,#recipeTextOld,.recipe-explanation,.limiting-factor{display:none !important}
    .cf-recipe-compare{margin-top:13px;padding-top:12px;border-top:1px solid rgba(255,255,255,.11)}
    .cf-recipe-compare-head{display:flex;justify-content:space-between;gap:8px;font-size:7px;color:#a7c4b8;text-transform:uppercase;letter-spacing:.1em;font-weight:900}
    .cf-tech-row{display:grid;grid-template-columns:116px 1fr 34px;gap:8px;align-items:center;margin-top:9px}
    .cf-tech-row b{font-size:8px;color:#f0f8f4}
    .cf-tech-row.active b{color:#dff6ad}
    .cf-tech-track{height:7px;border-radius:999px;background:rgba(255,255,255,.09);overflow:hidden}
    .cf-tech-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#b7e76b,#58d1b2)}
    .cf-tech-score{font-size:8px;text-align:right;color:#c8ddd4;font-weight:900}
    .cf-recipe-inputs{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
    .cf-recipe-input{padding:6px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);font-size:7px;color:#b9cec5}
    .cf-recipe-input b{color:#eef8f4}

    /* ---------- network pulse ---------- */
    #cfPulsePanel{padding:18px}
    .cf-pulse-stage{margin-top:12px;padding:12px 12px 10px;border:1px solid #e0ebe5;border-radius:16px;background:#fbfdfc}
    .cf-pulse-chart{width:100%;height:150px;display:block}
    .cf-pulse-chart .grid{stroke:#e4ece8;stroke-width:1}
    .cf-pulse-chart .area{fill:rgba(21,155,131,.08)}
    .cf-pulse-chart .line{fill:none;stroke:var(--teal);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
    .cf-pulse-chart .point{fill:#fff;stroke:var(--teal);stroke-width:2.5}
    .cf-pulse-chart .point.active{fill:var(--lime);stroke:#6c9b2a}
    .cf-pulse-labels{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-top:7px}
    .cf-pulse-label{text-align:center;font-size:6.5px;color:#7f9189}
    .cf-pulse-label b{display:block;font-size:8px;color:var(--ink);margin-top:2px}
    .cf-pulse-note{margin-top:8px;font-size:7px;line-height:1.45;color:#7f9189}

    /* ---------- thinking dial flattened ---------- */
    .thinking-final{margin-top:18px !important}
    .thinking-final .decision-dial-wrap{padding:18px !important}
    .thinking-final .decision-dial{height:auto !important;min-height:0 !important;border-radius:20px !important;background:linear-gradient(145deg,#fff,#f1f8f4) !important;box-shadow:none !important;overflow:visible !important;display:grid !important;grid-template-columns:repeat(7,minmax(0,1fr)) !important;gap:8px !important;padding:0 !important}
    .thinking-final .dial-track,.thinking-final .dial-halo,.thinking-final .dial-tick,.thinking-final .dial-core{display:none !important}
    .thinking-final .dial-node{position:relative !important;inset:auto !important;transform:none !important;width:auto !important;height:auto !important;min-height:86px !important;border-radius:15px !important;background:#fff !important;border:1px solid var(--line) !important;box-shadow:none !important;padding:10px !important}
    .thinking-final .dial-node.active{border-color:#bfe3d3 !important;background:#eef9f4 !important}
    .thinking-final .dial-icon{width:30px !important;height:30px !important;display:grid !important;place-items:center !important;margin:6px auto 5px !important;border-radius:9px !important;background:var(--mint) !important;color:var(--teal) !important}
    .thinking-final .dial-num{display:block !important;font-size:6px !important}
    .thinking-final .dial-node b{font-size:7.5px !important}
    .thinking-final .dial-node small{font-size:6.5px !important}

    /* ---------- map ---------- */
    #leafletMap{z-index:1}
    .map .map-head{pointer-events:none}
    .map .map-stats{pointer-events:none}
    .map .leaflet-top.leaflet-right{margin-top:34px}
    .cf-map-legend{background:rgba(255,255,255,.95);border-radius:12px;padding:8px 10px;box-shadow:0 4px 16px rgba(16,40,32,.12);font-family:Inter,system-ui,sans-serif}
    .cf-lg-row{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:700;color:#294a3f;line-height:1;margin:5px 0}
    .cf-lg-row:first-child{margin-top:0}.cf-lg-row:last-child{margin-bottom:0}
    .cf-lg-ico{width:16px;display:flex;justify-content:center}
    .cf-lg-src{width:11px;height:11px;border-radius:50%;background:#ff7a00;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15)}
    .cf-lg-fac{width:11px;height:11px;border-radius:3px;background:#2563eb;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15)}
    .cf-lg-flow{width:16px;height:4px;border-radius:3px;background:var(--teal);opacity:.8}
    .cf-lg-note{margin-top:7px;font-size:8px;color:#8aa096;font-weight:700}
    .cf-lg-sep{height:1px;background:#e3ece7;margin:7px 0}
    .cf-lg-dots{display:flex;gap:9px;font-size:8.5px;font-weight:800;color:#6b8379}
    .cf-lg-dots span{display:inline-flex;align-items:center;gap:4px}
    .cf-lg-dots i{width:7px;height:7px;border-radius:50%}
    .cf-pin-wrap{background:none !important;border:0 !important}
    .cf-pin{position:relative;display:grid;place-items:center;width:100%;height:100%;box-sizing:border-box;border:3px solid #fff;color:#fff;font-size:11px;font-weight:900;line-height:1;background:var(--pc,#2563eb);box-shadow:0 3px 10px rgba(16,40,32,.3);transition:transform .18s,box-shadow .18s,opacity .2s;cursor:pointer}
    .cf-pin.src{border-radius:50%;--pc:#ff7a00;font-size:8px}
    .cf-pin.fac{border-radius:9px}
    .cf-pin:hover{transform:scale(1.14)}
    .cf-pin.sel{transform:scale(1.22);box-shadow:0 0 0 4px rgba(21,155,131,.38),0 6px 16px rgba(16,40,32,.35)}
    .cf-pin.dim{opacity:.62}
    .cf-pin.bound::after{content:"";position:absolute;inset:-7px;border-radius:inherit;border:2px solid var(--pc);animation:cfPing 1.8s ease-out infinite;pointer-events:none}
    .cf-pin .lf{position:absolute;right:-6px;top:-6px;width:12px;height:12px;border-radius:50%;background:#e98258;border:2px solid #fff}
    @keyframes cfPing{0%{transform:scale(.85);opacity:.7}100%{transform:scale(1.4);opacity:0}}
    .cf-flow{stroke-dasharray:7 9;animation:cfDash 1.1s linear infinite;transition:opacity .2s}
    @keyframes cfDash{to{stroke-dashoffset:-16}}
    .leaflet-tooltip.cf-tip{border:0;border-radius:10px;padding:6px 9px;font-family:Inter,system-ui,sans-serif;font-size:10.5px;color:#18382e;box-shadow:0 6px 18px rgba(16,40,32,.18)}
    .leaflet-tooltip.cf-tip b{font-size:11px}
    .leaflet-tooltip.cf-tip span{display:block;color:#5d776c;font-size:9.5px;margin-top:1px}
    .cf-map-detail{position:absolute;left:16px;bottom:46px;z-index:9;width:min(270px,calc(100% - 32px));padding:11px 12px;border-radius:16px;background:rgba(255,255,255,.97);border:1px solid #dce9e3;box-shadow:0 12px 30px rgba(16,40,32,.16);font-family:Inter,system-ui,sans-serif;display:none}
    .cf-map-detail.open{display:block}
    .cf-md-top{display:flex;justify-content:space-between;align-items:center}
    .cf-md-x{border:0;background:#f1f6f3;color:#5d776c;width:20px;height:20px;border-radius:7px;font-size:12px;line-height:1;padding:0}
    .cf-md-name{display:block;margin:7px 0 6px;font-size:14px;letter-spacing:-.02em;color:#18382e;line-height:1.2}
    .cf-md-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
    .cf-md-row{display:flex;justify-content:space-between;font-size:9.5px;color:#5d776c;margin-bottom:4px}
    .cf-md-row b{color:#18382e}
    .cf-md-feeds{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
    .cf-md-feeds span{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border-radius:999px;background:#f5f9f7;border:1px solid #e1ebe6;font-size:8.5px;color:#4f685d;font-weight:800}
    .cf-md-feeds i{width:7px;height:7px;border-radius:50%}

    /* ---------- final polish ---------- */
    .cf-kick{font-size:9px;letter-spacing:.14em;text-transform:uppercase;font-weight:900;color:var(--teal-dark);margin-bottom:3px}
    .cf-panel-head h4{font-size:18px}
    .cf-panel{padding:20px}
    .cf-pill{font-size:9px}
    .cf-sec{font-size:9px;margin:16px 0 7px}
    .cf-foot{font-size:9.5px;margin-top:14px}
    .cf-badge{font-size:9px;padding:3px 8px}
    .cf-delta{font-size:9px}
    .cf-chainitem small{font-size:9px}
    .cf-chainitem b{font-size:16px}
    .cf-chainitem span{font-size:10px}
    .cf-mini span{font-size:8.5px}.cf-mini b{font-size:20px}.cf-mini b em{font-size:9px}
    .cf-ring small{font-size:8px;max-width:70px;line-height:1.2}
    .cf-legend{font-size:9.5px}
    .cf-fac-name b{font-size:11px}.cf-fac-bar small{font-size:9px}.cf-fac-val b{font-size:11px}
    .cf-step-k{font-size:8.5px}.cf-step b{font-size:12px}.cf-step span{font-size:10px;line-height:1.4}
    .cf-route-row b{font-size:11px}.cf-route-row small{font-size:9.5px}
    .cf-dchip{font-size:9.5px}.cf-dchip em{font-size:8.5px}
    .cf-out-head b{font-size:14px}
    .cf-tile span{font-size:8.5px}.cf-tile b{font-size:21px}.cf-tile small{font-size:9px}
    .cf-meter-head{font-size:10px}.cf-meter-head b{font-size:12px}
    .cf-meter-head em{font-style:normal;font-weight:600;color:#8a9b93;font-size:9px;margin-left:3px}
    .cf-chip-node b{font-size:10.5px}.cf-match-qty b{font-size:11px}
    .cf-remain{font-size:9.5px}
    .cf-out-card{padding:14px;margin-top:14px}
    .cf-match{padding:8px 10px}
    .cf-imp-row{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;font-size:10px;color:#71837b;font-weight:700}
    .cf-imp-row b{font-size:12px;color:var(--ink)}
    .cf-imp-track{height:7px;border-radius:999px;background:#eaf0ec;overflow:hidden;margin-top:4px}
    .cf-imp-track i{display:block;height:100%;border-radius:inherit;transition:width .5s ease}
    .cf-imp-unit{margin-top:8px;font-size:9px;color:#8a9b93}
    .decision-option.primary{background:var(--teal);border-color:var(--teal);box-shadow:0 8px 18px rgba(21,155,131,.22)}
    .decision-option.primary span{color:#d9f3ea}.decision-option.primary b{color:#fff}
    .decision-option span{font-size:9px}.decision-option b{font-size:11px}
    .reason{font-size:9.5px;padding:6px 10px}
    .decision .move h3{font-size:36px;letter-spacing:-.05em}
    .decision .move p{font-size:12.5px;line-height:1.5}
    .scope{font-size:9.5px;max-width:62%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .map-stats .map-chip{font-size:10px}
    .cf-pin{border-width:3px;box-shadow:0 0 0 1px rgba(16,40,32,.28),0 4px 12px rgba(16,40,32,.32)}
    .cf-pin.sel{box-shadow:0 0 0 3px #fff,0 0 0 6px rgba(13,116,99,.75),0 8px 18px rgba(16,40,32,.38)}
    .cf-lg-row{font-size:10.5px}.cf-lg-dots{font-size:9.5px}.cf-lg-note{font-size:9px}
    .cf-map-detail{padding:14px 15px;bottom:54px;width:min(288px,calc(100% - 32px))}
    .cf-md-name{margin:9px 0 8px;font-size:15px}
    .cf-md-badges{margin-bottom:11px;gap:6px}
    .cf-md-row{font-size:10.5px;margin-bottom:6px}
    .cf-md-feeds{margin-top:11px;gap:6px}.cf-md-feeds span{font-size:9.5px;padding:3px 8px}
    #impact{align-items:start}
    #impact .legend-row{font-size:10.5px;gap:14px;margin-top:12px;flex-wrap:wrap}
    #impact .legend-row i{width:9px;height:9px}
    #impact .chart-label{font-size:11px}
    #impact .impact-note{font-size:10.5px}
    #impact .impact-unit{font-size:10.5px}
    .cf-pulse-label{font-size:8.5px}.cf-pulse-label b{font-size:10px}.cf-pulse-note{font-size:9px}

    /* ---------- responsive ---------- */
    @media(max-width:1180px){
      .cf-dashboard-grid{grid-template-columns:1fr}
      .cf-chainbar{grid-template-columns:1fr 1fr}
      .cf-chainitem:not(:last-child)::after{display:none}
      .thinking-final .decision-dial{grid-template-columns:repeat(4,minmax(0,1fr)) !important}
    }
    @media(max-width:760px){
      .cf-chainbar{grid-template-columns:1fr}
      .cf-cap-hero{grid-template-columns:1fr;justify-items:center}
      .cf-cap-hero .cf-mini-grid{width:100%}
      .cf-steps{grid-template-columns:1fr}
      .cf-step:not(:last-child)::after{display:none}
      .cf-pipe{grid-template-columns:repeat(3,1fr);gap:6px}
      .cf-tile span{font-size:7.5px;letter-spacing:.05em}
      .decision .move h3{font-size:30px}
      .scope{max-width:100%}
      .cf-pipe-arrow{display:none}
      .cf-tile b{font-size:16px}
      .cf-map-detail{width:calc(100% - 32px)}
      .cf-meters{grid-template-columns:1fr}
      .cf-match{grid-template-columns:1fr auto}
      .cf-match-arrow{display:none}
      .cf-fac-row{grid-template-columns:118px 1fr;gap:6px 10px}
      .cf-fac-val{grid-column:1/-1;justify-content:flex-start}
      .cf-pulse-labels{grid-template-columns:1fr 1fr}
      .thinking-final .decision-dial{grid-template-columns:repeat(2,minmax(0,1fr)) !important}
      .cf-map-detail{bottom:50px}
    }
  `;

  // ---------------------------------------------------------------------------
  // Dynamic sections
  // ---------------------------------------------------------------------------

  function injectCleanSections() {
    if ($("cfCleanSection")) return;
    const style = document.createElement("style");
    style.textContent = CF_CSS;
    document.head.appendChild(style);

    const section = document.createElement("section");
    section.id = "cfCleanSection";
    section.className = "cf-clean";
    section.innerHTML = `
      <div class="cf-chainbar">
        <div class="cf-chainitem"><small>1 · Scenario</small><b id="cfChainScenario">—</b><span id="cfChainScenarioText">&nbsp;</span></div>
        <div class="cf-chainitem"><small>2 · Impact</small><b id="cfChainImpact">—</b><span id="cfChainImpactText">&nbsp;</span></div>
        <div class="cf-chainitem"><small>3 · Decision</small><b id="cfChainDecision">—</b><span id="cfChainDecisionText">&nbsp;</span></div>
        <div class="cf-chainitem"><small>4 · Output</small><b id="cfChainOutput">—</b><span id="cfChainOutputText">&nbsp;</span></div>
      </div>
      <div class="cf-dashboard-grid">
        <div class="cf-left-stack">
          <article class="cf-panel" id="cfCapacityPanel"></article>
          <article class="cf-panel" id="cfWhyPanel"></article>
        </div>
        <article class="cf-panel cf-matching-panel" id="cfMatchingPanel"></article>
      </div>
    `;
    const main = document.querySelector("section.main");
    if (main?.parentNode) main.parentNode.insertBefore(section, main.nextSibling);
  }

  // ---------------------------------------------------------------------------
  // Recipe cleanup
  // ---------------------------------------------------------------------------

  function cleanStaticRecipeUI() {
    const title = document.querySelector(".recipe-title h3");
    const copy = document.querySelector(".recipe-title p");
    const journeyTitle = document.querySelector(".journey-title");
    const side = document.querySelector(".recipe-side");
    const recipeTag = document.querySelector(".recipe-controls .badge-pop");

    if (title) title.textContent = "♻ Feedstock compatibility";
    if (copy) copy.textContent = "Test the waste profile first. The Recipe Engine scores pathway fit; the optimizer remains independent.";
    if (journeyTitle) journeyTitle.textContent = "What fits this feedstock?";
    if (recipeTag) recipeTag.innerHTML = "<strong>advisory layer</strong> · solver stays independent";

    document
      .querySelectorAll(".recipe-insight,#limitingTitle,#limitingText,.recipe-explanation,.limiting-factor")
      .forEach((node) => { node.style.display = "none"; });

    const recipeText = $("recipeText");
    if (recipeText) recipeText.textContent = "The selected pathway is a feedstock-compatibility signal, not a solver instruction.";

    const recipeFactors = document.querySelector(".recipe-factors");
    if (recipeFactors) {
      const f = (label, id) => `
        <div class="factor">
          <span class="factor-badge">INPUT</span>
          <div class="factor-head"><span>${label}</span><b id="${id}">—</b></div>
          <small>submitted feedstock value</small>
        </div>`;
      recipeFactors.innerHTML =
        f("Organic fraction", "rfOrganic") + f("Moisture", "rfMoisture") +
        f("Contamination", "rfContamination") + f("C:N ratio", "rfCn");
    }

    if (side) {
      side.innerHTML = `
        <div class="mini-label">Compatibility signal</div>
        <div class="verdict">
          <div class="verdict-dot">✓</div>
          <div><b id="recipeState">—</b><span id="recipeConfidence">—</span></div>
        </div>
        <div class="compat" id="recipeCompat"></div>
        <div class="cf-recipe-compare">
          <div class="cf-recipe-compare-head"><span>Technology comparison</span><span>/ 100</span></div>
          <div id="recipeCompare"></div>
        </div>
        <div class="cf-recipe-inputs" id="recipeInputs"></div>
        <div class="recipe-meter">
          <div class="meter-line"><span>Top pathway compatibility</span><b id="recipeMeterValue">—</b></div>
          <div class="meter"><i id="recipeMeter" style="width:0%"></i></div>
        </div>
        <div class="recipe-note"><b>Boundary:</b> recipe fit explains the stream; it never silently changes the network allocation.</div>
      `;
    }

    const nodes = document.querySelectorAll(".journey-path .j-node");
    if (nodes.length >= 3) {
      nodes[0].querySelector("b").textContent = "INPUT";
      nodes[1].querySelector("b").textContent = "BEST FIT";
      nodes[2].querySelector("b").textContent = "VALUE";
    }
  }

  // ---------------------------------------------------------------------------
  // Static labels (footer is intentionally left alone: it carries photo/map attribution)
  // ---------------------------------------------------------------------------

  function fixStaticText() {
    const modeNote = document.querySelector(".mode-note div span");
    if (modeNote) modeNote.textContent = "live API · evidence-labelled values";

    document.querySelectorAll(".analytics .panel").forEach((panel) => {
      const heading = panel.querySelector(".panel-head h3");
      if (heading?.textContent.trim().toLowerCase() === "network pulse") panel.id = "cfPulsePanel";
    });

    const pulseLabel = document.querySelector("#cfPulsePanel .panel-head span");
    if (pulseLabel) pulseLabel.textContent = "scenario diversion";
  }

  // ---------------------------------------------------------------------------
  // Hero scenario strip
  // ---------------------------------------------------------------------------

  function renderHeroStrip(selectedScenario) {
    const chart = $("scenarioChart");
    if (!chart) return;

    chart.querySelectorAll(".scenario-bar-col").forEach((col) => {
      const sid = col.dataset.scenario;
      const cached = heroCache[sid];
      const fill = col.querySelector(".scenario-bar-fill");
      const value = col.querySelector(".scenario-bar-value");
      col.classList.toggle("active", sid === selectedScenario);
      if (!cached?.economics) return;
      const diversion = cached.economics.landfill_diversion_pct.value;
      if (diversion == null) return;
      const p = pct(diversion);
      if (fill) fill.style.height = p + "%";
      if (value) {
        value.textContent = Math.round(p) + "%";
        value.style.bottom = `calc(${p}% - 2px)`;
      }
    });

    setText("heroChartScenario", SCENARIO_LABELS[selectedScenario] || selectedScenario);

    // Hero "current" readout follows the run actually on screen (which may be a non-natural capacity mode)
    const selected = lastResult && lastScenarioId === selectedScenario ? lastResult : heroCache[selectedScenario];
    if (selected?.economics) {
      const diversion = selected.economics.landfill_diversion_pct.value;
      setText("heroDiversion", diversion == null ? "—" : diversion.toFixed(1) + "%");
      const { decision } = pickHeadline(selected.decisions);
      setText("heroDecision", decision ? titleCaseDecision(decision).toUpperCase() : "—");
    }
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  function renderMain(result, scenarioId) {
    lastResult = result;
    lastScenarioId = scenarioId;

    const r = result.optimizer_result;
    const econ = result.economics;
    const om = result.output_matching;
    const decisions = result.decisions || {};
    const mode = String(result.capacity_mode || "").toLowerCase();
    const mInfo = modeInfo(mode);

    setStatus("DEMO · FY2025–26 Delhi baseline", true);

    if (r.status !== "Optimal") {
      setText("decisionTitle", "Scenario infeasible");
      setText("decisionText", r.message || "The solver could not find a feasible allocation.");
      clearKpis();
      renderCompactDecisionChain(result);
      renderCapacityPanel(result);
      renderWhyPanel(result);
      renderMatchingPanel(result);
      renderImpactDetail(null);
      renderPulse();
      return;
    }

    // ---- KPI values ----
    const allocatedTotal = sum(Object.values(r.tonnes_allocated_tpd || {}));
    const totalGenerated = allocatedTotal + Number(r.total_landfilled_tpd || 0);
    setText("throughput", fmt(totalGenerated));
    setText("throughputProcessed", fmt(allocatedTotal, 0));
    setText("throughputLandfilled", fmt(r.total_landfilled_tpd || 0, 0));
    const tpP = $("tpProcessedBar");
    const tpL = $("tpLandfillBar");
    if (tpP) tpP.style.width = (totalGenerated > 0 ? (allocatedTotal / totalGenerated) * 100 : 0) + "%";
    if (tpL) tpL.style.width = (totalGenerated > 0 ? (Number(r.total_landfilled_tpd || 0) / totalGenerated) * 100 : 0) + "%";

    const throughputNote = document.querySelector("#throughputCard .note");
    if (throughputNote) {
      throughputNote.textContent = mode === "incremental_spare" ? "TPD · additional waste" : "TPD · whole network";
    }

    const diversion = econ?.landfill_diversion_pct?.value ?? null;
    const pressure = diversion == null ? null : 100 - diversion;

    const landfillCard = $("landfillCard");
    const diversionCard = $("diversionCard");
    landfillCard?.classList.remove("warn", "alert", "critical");
    diversionCard?.classList.remove("warn", "alert");

    if (pressure != null) {
      if (pressure >= 65) landfillCard?.classList.add("critical");
      else if (pressure >= 55) landfillCard?.classList.add("alert");
      else if (pressure >= 45) landfillCard?.classList.add("warn");
    }
    if (diversion != null) {
      if (diversion < 50) diversionCard?.classList.add("alert");
      else if (diversion < 60) diversionCard?.classList.add("warn");
    }

    setText("landfill", fmt(r.total_landfilled_tpd || 0));
    setText("landfillPressure", pressure == null ? "—" : pressure.toFixed(1) + "%");
    setText("landfillState", pressure == null ? "N/A" : "PRESSURE " + pressure.toFixed(1) + "%");
    const pressureFill = $("pressureFill");
    if (pressureFill) pressureFill.style.width = Math.min(100, pressure || 0) + "%";

    setText("diversion", diversion == null ? "—" : diversion.toFixed(1) + "%");
    setText(
      "diversionState",
      diversion == null ? "N/A" : diversion >= 80 ? "VERY HIGH" : diversion >= 60 ? "HEALTHY" : diversion >= 50 ? "WATCH" : "LOW"
    );

    const ring = $("diversionRing");
    if (ring) {
      const p = diversion == null ? 0 : diversion;
      ring.style.background = `conic-gradient(var(--teal) 0 ${p}%, #e6eee9 ${p}% 100%)`;
      const label = ring.querySelector("span");
      if (label) label.textContent = diversion == null ? "—" : Math.round(p) + "%";
    }

    const power = om?.by_output_type?.power_mwh;
    const powerMatched = power?.total_matched_per_day ?? null;
    const powerUtil = power?.utilization_of_recovered_output_pct ?? null;
    setText("power", powerMatched == null ? "—" : fmt(powerMatched));
    setText("powerState", powerUtil == null ? "N/A" : powerUtil < 90 ? "PARTIAL MATCH" : "MATCHED");
    const powerFill = $("powerFill");
    if (powerFill) powerFill.style.setProperty("--power-width", (powerUtil || 0) + "%");

    // ---- Headline decision ----
    const { fid, decision, allStable } = pickHeadline(decisions);

    const scenarioLabel = SCENARIO_LABELS[scenarioId] || prettyId(scenarioId);
    setText("scopeTag", `${scenarioLabel} · ${mInfo.label}`);
    const scopeTag = $("scopeTag");
    if (scopeTag) scopeTag.title = `Scenario: ${scenarioLabel} — ${mode}: ${mInfo.sub}`;

    setText("moveIcon", decision && DECISION_ICON[decision] ? DECISION_ICON[decision] : "●");

    if (!fid) {
      setText("decisionTitle", "No decision");
      setText("decisionText", "This scenario produced no facility decisions.");
    } else if (allStable) {
      setText("decisionTitle", "Hold");
      setText("decisionText", `All ${Object.keys(decisions).length} facilities keep their baseline allocation.`);
    } else {
      setText("decisionTitle", titleCaseDecision(decision));
      const info = result.explanation?.facility_decisions?.[fid];
      const reason = info?.reasons?.[info.reasons.length - 1];
      const others = Object.values(decisions).filter((d) => d !== "DO_NOTHING").length - 1;
      setText(
        "decisionText",
        `${displayName(fid)}${others > 0 ? ` (+${others} more)` : ""} — ${reason ? humanizeReason(reason).text : "explanation unavailable"}`
      );
    }

    const reasonLine = $("reasonLine");
    if (reasonLine) {
      const info = fid && result.explanation?.facility_decisions?.[fid];
      const reasons = info?.reasons || [];
      const chips = [];
      reasons.slice(1, 3).forEach((raw) => chips.push(humanizeReason(raw).title));
      chips.push(mInfo.label);
      reasonLine.innerHTML = chips.map((c) => `<span class="reason">${esc(c)}</span>`).join("");
    }

    const occurring = new Set(Object.values(decisions));
    const tileIds = { BUILD: "buildOption", RETROFIT: "retrofitOption", REROUTE: "rerouteOption", DO_NOTHING: "nothingOption" };
    Object.entries(tileIds).forEach(([type, id]) => {
      const node = $(id);
      if (!node) return;
      node.classList.toggle("active", occurring.has(type));
      node.classList.toggle("primary", type === decision);
      const span = node.querySelector("span");
      const b = node.querySelector("b");
      if (span) span.textContent = DECISIONS[type].label.toUpperCase();
      if (b) b.textContent = DECISIONS[type].sub.toLowerCase();
    });

    // ---- Lower analytics ----
    setText("divertedBar", diversion == null ? "—" : diversion.toFixed(1) + "%");
    const legend = document.querySelector("#impact .legend-row");
    if (legend) {
      legend.innerHTML =
        `<span><i style="background:var(--teal)"></i>processed ${fmt(allocatedTotal, 0)} TPD</span>` +
        `<span><i style="background:var(--orange)"></i>landfilled ${fmt(r.total_landfilled_tpd || 0, 0)} TPD</span>`;
    }
    const divertedFill = $("divertedFill");
    const landfillFill = $("landfillFill");
    if (divertedFill) divertedFill.style.width = (diversion || 0) + "%";
    if (landfillFill) landfillFill.style.width = (pressure || 0) + "%";

    const avoided = econ?.lifecycle_impact_tco2e_per_year?.avoided_emissions?.value;
    setText("emissions", avoided == null ? "—" : formatCompact(avoided));

    if (econ) {
      const net = econ.net_annual_cost_after_recovery_rs?.value;
      setText(
        "impactNote",
        `Modelled vs an all-landfilled baseline · financial cost ₹${formatCompact(econ.financial_cost_rs_per_year?.value)}/yr` +
          (net != null ? ` (₹${formatCompact(net)}/yr net of recovered power).` : ".")
      );
    }
    renderImpactDetail(econ);

    renderHeroStrip(scenarioId);
    renderCompactDecisionChain(result);
    renderCapacityPanel(result);
    renderWhyPanel(result);
    renderMatchingPanel(result);
    renderPulse();
  }

  function renderImpactDetail(econ) {
    const host = $("impactDetail");
    if (!host) return;
    const li = econ?.lifecycle_impact_tco2e_per_year;
    const cf = li?.counterfactual_if_all_landfilled?.value;
    const act = li?.total_actual_emissions?.value;
    if (cf == null || act == null) {
      host.innerHTML = "";
      return;
    }
    const base = Math.max(cf, act, 1);
    host.innerHTML = `
      <div class="cf-imp-row"><span>If all landfilled</span><b>${formatCompact(cf)}</b></div>
      <div class="cf-imp-track"><i style="width:${pct((cf / base) * 100)}%;background:#c5d3cb"></i></div>
      <div class="cf-imp-row"><span>This scenario</span><b>${formatCompact(act)}</b></div>
      <div class="cf-imp-track"><i style="width:${pct((act / base) * 100)}%;background:var(--teal)"></i></div>`;
  }

  // ---------------------------------------------------------------------------
  // Decision chain
  // ---------------------------------------------------------------------------

  function renderCompactDecisionChain(result) {
    const r = result.optimizer_result || {};
    const econ = result.economics;
    const { fid, decision, allStable } = pickHeadline(result.decisions || {});
    const ok = r.status === "Optimal";
    const scenarioLabel = SCENARIO_LABELS[result.scenario] || prettyId(result.scenario);
    const div = econ?.landfill_diversion_pct?.value;
    const power = result.output_matching?.by_output_type?.power_mwh?.total_matched_per_day;

    setText("cfChainScenario", scenarioLabel);
    setText("cfChainScenarioText", modeInfo(result.capacity_mode).label);
    setText("cfChainImpact", ok && div != null ? `${div.toFixed(1)}% diverted` : "—");
    setText("cfChainImpactText", ok ? `${fmt(r.total_landfilled_tpd || 0, 0)} TPD landfilled` : "no feasible run");
    setText("cfChainDecision", ok ? (allStable ? "Hold" : titleCaseDecision(decision)) : "—");
    setText("cfChainDecisionText", ok ? (fid ? (allStable ? "all facilities" : shortName(fid)) : "network action") : "—");
    setText("cfChainOutput", power == null ? "—" : `${fmt(power, 0)} MWh/d`);
    setText("cfChainOutputText", "power matched to demand");
  }

  // ---------------------------------------------------------------------------
  // Spare capacity / allocation
  // ---------------------------------------------------------------------------

  function renderCapacityPanel(result) {
    const host = $("cfCapacityPanel");
    if (!host) return;

    const r = result.optimizer_result || {};
    const mode = result.capacity_mode || "total_network";
    const incremental = mode === "incremental_spare";
    const base = r.base_capacity_tpd || {};
    const alloc = r.tonnes_allocated_tpd || {};
    const baseAlloc = result.baseline_result?.tonnes_allocated_tpd || {};
    const binding = new Set(r.capacity_binding || []);

    const rows = (network?.facilities || [])
      .filter((f) => base[f.id] !== undefined)
      .map((f) => {
        const nameplate = Number(f.capacity_tpd?.value || 0);
        const available = Number(base[f.id] || 0);
        const allocated = Number(alloc[f.id] || 0);
        const remaining = Math.max(0, available - allocated);
        const load = incremental ? Math.max(0, nameplate - available) : 0;
        const st = facilityLiveStatus(f.id, result);
        const delta = allocated - Number(baseAlloc[f.id] || 0);
        return {
          f, nameplate, available, allocated, remaining, load, delta,
          binding: binding.has(f.id), offline: st?.key === "offline", decision: result.decisions?.[f.id],
        };
      });

    if (!rows.length) {
      host.innerHTML = `
        <div class="cf-panel-head"><div><div class="cf-kick">Impact</div><h4>Spare capacity / allocation</h4>
        <p>No facility capacity data was returned for this run.</p></div></div>`;
      return;
    }

    const totalNameplate = sum(rows.map((x) => x.nameplate));
    const totalAvailable = sum(rows.map((x) => x.available));
    const totalAllocated = sum(rows.map((x) => x.allocated));
    const totalRemaining = sum(rows.map((x) => x.remaining));
    const totalLoad = sum(rows.map((x) => x.load));
    const landfilled = Number(r.total_landfilled_tpd || 0);

    const util = totalAvailable > 0 ? pct((totalAllocated / totalAvailable) * 100) : 0;
    const ringColor = util >= 95 ? "#e98258" : util >= 80 ? "#f1bb57" : "var(--teal)";

    const usedPct = totalNameplate > 0 ? Math.min(100, (totalAllocated / totalNameplate) * 100) : 0;
    const loadPct = incremental && totalNameplate > 0 ? Math.min(100 - usedPct, (totalLoad / totalNameplate) * 100) : 0;
    const freePct = Math.max(0, 100 - usedPct - loadPct);

    const rowHtml = rows.map((x) => {
      const denom = Math.max(1, x.nameplate);
      const loadW = incremental ? Math.min(100, (x.load / denom) * 100) : 0;
      const allocW = Math.min(100 - loadW, (x.allocated / denom) * 100);
      const freeW = Math.max(0, 100 - loadW - allocW);
      const util1 = x.available > 0 ? (x.allocated / x.available) * 100 : 0;

      let badge;
      if (x.offline) badge = '<span class="cf-badge off">Offline</span>';
      else if (x.binding) badge = '<span class="cf-badge full">Full</span>';
      else badge = `<span class="cf-badge ${util1 >= 80 ? "warn" : "ok"}">${Math.round(util1)}%</span>`;

      let deltaChip = "";
      if (!incremental && !x.offline && Math.abs(x.delta) >= 0.5) {
        deltaChip = `<span class="cf-delta ${x.delta < 0 ? "down" : ""}" title="Change vs baseline run">${x.delta > 0 ? "▲ +" : "▼ "}${fmt(x.delta, 0)}</span>`;
      }
      if (x.decision === "BUILD") badge = '<span class="cf-badge build">Build</span>' + badge;
      if (x.decision === "RETROFIT") badge = '<span class="cf-badge retrofit">Retrofit</span>' + badge;

      const bar = x.offline
        ? '<div class="cf-bar off"></div>'
        : `<div class="cf-bar ${x.binding ? "full" : ""}">
            ${incremental && loadW ? `<i class="load" style="width:${loadW}%"></i>` : ""}
            <i class="used" style="width:${allocW}%"></i><i class="free" style="width:${freeW}%"></i>
           </div>`;

      return `
        <div class="cf-fac-row">
          <div class="cf-fac-name"><i style="background:${colorOf(x.f.id)}"></i><b title="${esc(displayName(x.f.id))}">${esc(shortName(x.f.id))}</b></div>
          <div class="cf-fac-bar">${bar}
            <small>${incremental ? `spare ${fmt(x.available, 0)}` : `nameplate ${fmt(x.nameplate, 0)}`} TPD${x.offline ? "" : ` · free ${fmt(x.remaining, 0)}`}</small>
          </div>
          <div class="cf-fac-val"><b>${x.offline ? "—" : fmt(x.allocated, 0)} <em>/ ${fmt(x.available, 0)}</em></b>${deltaChip}${badge}</div>
        </div>`;
    }).join("");

    const cityRef = r.city_reference_capacity_tpd?.value;

    host.innerHTML = `
      <div class="cf-panel-head">
        <div><div class="cf-kick">Impact</div><h4>Spare capacity / allocation</h4></div>
        <span class="cf-pill" title="${esc(modeInfo(mode).sub)}">${esc(modeInfo(mode).label)}</span>
      </div>

      <div class="cf-cap-hero">
        <div class="cf-ring" style="--p:${util}%;--c:${ringColor}">
          <div><b>${Math.round(util)}%</b><small>${incremental ? "of spare allocated" : "of capacity allocated"}</small></div>
        </div>
        <div class="cf-mini-grid">
          <div class="cf-mini accent"><span>${incremental ? "Spare available" : "Capacity available"}</span><b>${fmt(totalAvailable, 0)}<em>TPD</em></b></div>
          <div class="cf-mini"><span>Allocated</span><b>${fmt(totalAllocated, 0)}<em>TPD</em></b></div>
          <div class="cf-mini"><span>Free</span><b>${fmt(totalRemaining, 0)}<em>${binding.size} full</em></b></div>
          <div class="cf-mini ${landfilled > 0 ? "warn" : ""}"><span>Sent to landfill</span><b>${fmt(landfilled, 0)}<em>TPD</em></b></div>
        </div>
      </div>

      <div style="margin-top:14px">
        <div class="cf-bar total" aria-label="Network capacity allocation">
          ${incremental && loadPct ? `<i class="load" style="width:${loadPct}%"></i>` : ""}
          <i class="used" style="width:${usedPct}%"></i><i class="free" style="width:${freePct}%"></i>
        </div>
        <div class="cf-legend">
          ${incremental ? '<span><i class="sw-load"></i>existing load</span>' : ""}
          <span><i class="sw-used"></i>allocated</span><span><i class="sw-free"></i>free</span>
        </div>
      </div>

      <div class="cf-sec"><span>By facility</span><span>allocated / ${incremental ? "spare" : "capacity"} · TPD</span></div>
      ${rowHtml}

      <div class="cf-foot">
        <span class="cf-badge neutral">${incremental ? "spare basis" : "nameplate basis"}</span>
        <span>${incremental
          ? "Uses the backend's spare-capacity basis; current load is a DEMO assumption."
          : "No claim about current utilization."}</span>
        ${cityRef != null ? `<span class="cf-badge neutral" title="City-level reported metric; not netted against facility figures">city-reported ${fmt(cityRef, 0)} TPD · separate metric</span>` : ""}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Why this move
  // ---------------------------------------------------------------------------

  function decisionBadge(dec) {
    const cls = { BUILD: "build", RETROFIT: "retrofit", REROUTE: "warn", DO_NOTHING: "neutral" }[dec] || "neutral";
    return `<span class="cf-badge ${cls}">${esc(titleCaseDecision(dec))}</span>`;
  }

  function renderWhyPanel(result) {
    const host = $("cfWhyPanel");
    if (!host) return;

    const r = result.optimizer_result || {};
    const { fid, decision, allStable } = pickHeadline(result.decisions || {});
    const mode = result.capacity_mode || "total_network";
    const facility = fid ? displayName(fid) : "Network";
    const info = fid ? result.explanation?.facility_decisions?.[fid] : null;
    const reasons = info?.reasons || [];
    const codeOf = (raw) => (String(raw).match(/^[A-Z][A-Z_]+/) || [""])[0];
    const reasonCodes = reasons.map(codeOf);
    const binding = new Set(r.capacity_binding || []);
    const isBinding = fid ? binding.has(fid) : false;
    const isOffline = fid ? facilityLiveStatus(fid, result)?.key === "offline" : false;
    const scenarioLabel = SCENARIO_LABELS[result.scenario] || prettyId(result.scenario);
    const action = allStable ? "Hold" : titleCaseDecision(decision);
    const actionReason = reasons[0] ? humanizeReason(reasons[0]) : null;

    let constraintTitle = isBinding ? "At capacity" : "Feasible room";
    let constraintText = isBinding
      ? "This facility is at its modelled capacity."
      : "The current run leaves modelled room at this facility.";
    if (isOffline) {
      constraintTitle = "Offline";
      constraintText = "This facility is unavailable in this scenario; its flow is redirected.";
    }
    const constraintReason = isOffline ? null : reasons.find((raw) => /CAPACITY_BINDING|CAPACITY/i.test(String(raw)));
    if (constraintReason) {
      const parsed = humanizeReason(constraintReason);
      constraintTitle = parsed.title || constraintTitle;
      constraintText = parsed.text || constraintText;
    }

    const actionText = allStable
      ? "Keep the current allocation; the solver found no need to change it."
      : actionReason?.text || "The solver selected this facility-level action for the current scenario.";

    const extraCodes = reasonCodes
      .filter((code) => code && !["BUILD", "RETROFIT", "REROUTE", "DO_NOTHING", "NO_CHANGE_FROM_BASELINE_ALLOCATION", "CAPACITY_BINDING", "CAPACITY_BINDING_AT_DESTINATION"].includes(code))
      .slice(0, 3);

    // where each source's waste goes (real flows_tpd / landfilled_tpd)
    const sources = (network?.source_nodes || []).map((n) => n.id);
    const usedFacs = new Set();
    let anyLandfill = false;
    const routeRows = sources.map((sid) => {
      const li = sourceLiveInfo(sid, result);
      if (!li) return "";
      const total = li.routed + li.landfilled;
      if (li.landfilled > 0) anyLandfill = true;
      li.parts.forEach((p) => usedFacs.add(p.id));
      const segs = li.parts
        .map((p) => `<i style="flex:${p.tpd};background:${colorOf(p.id)}" title="${esc(shortName(p.id))}: ${fmt(p.tpd)} TPD"></i>`)
        .join("") +
        (li.landfilled > 0 ? `<i style="flex:${li.landfilled};background:${LANDFILL_COLOR}" title="Landfill: ${fmt(li.landfilled)} TPD"></i>` : "");
      return `
        <div class="cf-route-row">
          <b title="${esc(displayName(sid))}">${esc(shortName(sid))}</b>
          <div class="cf-stack ${total > 0 ? "" : "empty"}">${total > 0 ? segs : ""}</div>
          <small>${total > 0 ? fmt(total, 0) + " TPD" : "no new waste"}</small>
        </div>`;
    }).join("");

    const routeLegend = [...usedFacs]
      .map((id) => `<span><i style="background:${colorOf(id)}"></i>${esc(shortName(id))}</span>`)
      .join("") + (anyLandfill ? `<span><i class="sw-lf"></i>landfill</span>` : "");

    const decEntries = Object.entries(result.decisions || {});
    const uniform = decEntries.length > 1 && decEntries.every(([, d]) => d === decEntries[0][1]);
    const dchips = uniform
      ? `<span class="cf-dchip ${esc(decEntries[0][1])}">All ${decEntries.length} facilities<em>${esc(titleCaseDecision(decEntries[0][1]))}</em></span>`
      : decEntries
      .map(([id, dec]) => `<span class="cf-dchip ${esc(dec)}"><i style="background:${colorOf(id)}"></i>${esc(shortName(id))}<em>${esc(titleCaseDecision(dec))}</em></span>`)
      .join("");

    host.innerHTML = `
      <div class="cf-panel-head">
        <div><div class="cf-kick">Why</div><h4>Why this move?</h4></div>
        <span class="cf-pill">live explanation</span>
      </div>

      <div class="cf-why-top">
        <div class="cf-why-icon">${esc(DECISION_ICON[decision] || "●")}</div>
        <div class="cf-why-title">
          <b>${esc(action)} · ${esc(facility)}</b>
          <span>
            <span class="cf-badge neutral">${esc(scenarioLabel)}</span>
            <span class="cf-badge info">${esc(modeInfo(mode).label)}</span>
            <span class="cf-badge ${isOffline ? "off" : isBinding ? "full" : "ok"}">${isOffline ? "offline" : isBinding ? "capacity bound" : "capacity free"}</span>
          </span>
        </div>
        <span class="cf-badge neutral">${esc(result.mode || "demo")}</span>
      </div>

      <div class="cf-steps">
        <div class="cf-step"><div class="cf-step-k"><i>${esc(DECISION_ICON[decision] || "●")}</i>Action</div>
          <b>${esc(action)}</b><span title="${esc(actionText)}">${esc(actionText)}</span></div>
        <div class="cf-step ${isBinding || isOffline ? "warn" : ""}"><div class="cf-step-k"><i>${isBinding || isOffline ? "!" : "✓"}</i>Constraint</div>
          <b>${esc(constraintTitle)}</b><span title="${esc(constraintText)}">${esc(constraintText)}</span></div>
        <div class="cf-step"><div class="cf-step-k"><i>◎</i>Context</div>
          <b>${esc(scenarioLabel)}</b><span title="${esc(modeInfo(mode).sub)}">${esc(modeInfo(mode).sub)}</span></div>
      </div>

      ${routeRows ? `
        <div class="cf-sec"><span>Where each source's waste goes</span><span>TPD</span></div>
        ${routeRows}
        <div class="cf-legend">${routeLegend}</div>` : ""}

      ${dchips ? `<div class="cf-sec"><span>Facility decisions</span></div><div class="cf-dchips">${dchips}</div>` : ""}

      <div class="cf-foot">
        <span class="cf-badge neutral">Evidence</span>
        ${extraCodes.length
          ? extraCodes.map((code) => `<span class="cf-badge info">${esc(REASONS[code]?.[0] || prettyId(code))}</span>`).join("")
          : "<span>No further facility-level reasons returned.</span>"}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Output matching
  // ---------------------------------------------------------------------------

  function outputNodeId(value, fallback = "") {
    if (value == null) return fallback;
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "object") {
      return value.source_id || value.sourceId || value.demand_id || value.demandId || value.node_id || value.id || fallback;
    }
    return fallback;
  }

  function renderMatchingPanel(result) {
    const host = $("cfMatchingPanel");
    if (!host) return;

    const om = result.output_matching?.by_output_type;
    const r = result.optimizer_result || {};

    if (!om) {
      host.innerHTML = `
        <div class="cf-panel-head"><div><div class="cf-kick">Output</div><h4>Output-first matching</h4>
        <p>No output matching was returned for this run.</p></div></div>`;
      return;
    }

    const blocks = Object.entries(om).map(([type, d]) => {
      const lab = OUTPUT_LABELS[type] || { name: prettyId(type), unit: "per day", icon: "◆" };
      const matches = d.matches || [];
      const utilization = Number(d.utilization_of_recovered_output_pct || 0);
      const fulfilment = Number(d.demand_fulfilment_pct || 0);
      const supply = Number(d.total_supply_per_day || 0);
      const demand = Number(d.total_demand_per_day || 0);
      const matched = Number(d.total_matched_per_day || 0);
      const unmet = sum(Object.values(d.unmet_by_demand || {}));
      const unused = sum(Object.values(d.unused_by_source || {}));
      const maxQty = Math.max(1, ...matches.map((m) => Number(m.matched_quantity_per_day || 0)));
      const aux = d.stream_scope?.includes("AUXILIARY");

      const ledger = matches.map((m) => {
        const sourceId = outputNodeId(m.source, m.source_id || m.sourceId || "Recovery source");
        const demandId = outputNodeId(m.demand_node, m.demand_id || m.demandId || "Demand node");
        const qty = Number(m.matched_quantity_per_day || 0);
        return `
          <div class="cf-match">
            <div class="cf-chip-node"><i style="background:${colorOf(sourceId)}"></i><b title="${esc(displayName(sourceId))}">${esc(shortName(sourceId))}</b></div>
            <div class="cf-match-arrow">→</div>
            <div class="cf-chip-node"><i style="background:#60aeda"></i><b title="${esc(prettyId(demandId))}">${esc(shortName(demandId))}</b></div>
            <div class="cf-match-qty"><b>${fmt(qty)} <span style="font-size:7.5px;color:#8a9993;font-weight:700">${esc(lab.unit.split("/")[0])}</span></b>
              <div class="cf-track"><i style="width:${pct((qty / maxQty) * 100)}%"></i></div></div>
          </div>`;
      }).join("");

      const remains = [];
      if (unused > 0) remains.push(`<span class="cf-remain">unused recovered <b>${fmt(unused)} ${esc(lab.unit)}</b></span>`);
      if (unmet > 0) remains.push(`<span class="cf-remain">unmet demand <b>${fmtQ(unmet)} ${esc(lab.unit)}</b></span>`);
      if (!remains.length) remains.push('<span class="cf-remain good">all recovered output finds a modelled destination</span>');

      return `
        <div class="cf-out-card">
          <div class="cf-out-head">
            <b><i>${lab.icon}</i>${esc(lab.name)}</b>
            <span class="cf-badge ${aux ? "warn" : "ok"}" title="${esc(d.stream_scope || "")}">${aux ? "Auxiliary stream" : "Main network"}</span>
          </div>

          <div class="cf-pipe">
            <div class="cf-tile"><span>Recovered output</span><b>${fmtQ(supply)}</b><small>${esc(lab.unit)}</small></div>
            <div class="cf-pipe-arrow">›</div>
            <div class="cf-tile hl"><span>Matched to demand</span><b>${fmtQ(matched)}</b><small>${esc(lab.unit)}</small></div>
            <div class="cf-pipe-arrow">›</div>
            <div class="cf-tile"><span>Modelled demand</span><b>${fmtQ(demand)}</b><small>${esc(lab.unit)}</small></div>
          </div>

          <div class="cf-meters">
            <div>
              <div class="cf-meter-head"><span>Output matched <em>of recovered</em></span><b>${utilization.toFixed(1)}%</b></div>
              <div class="cf-track"><i style="width:${pct(utilization)}%"></i></div>
            </div>
            <div>
              <div class="cf-meter-head"><span>Demand met <em>of modelled demand</em></span><b class="alt">${fulfilment.toFixed(1)}%</b></div>
              <div class="cf-track"><i class="alt" style="width:${Math.max(fulfilment > 0 ? 1.5 : 0, pct(fulfilment))}%"></i></div>
            </div>
          </div>

          <div class="cf-ledger">
            ${ledger || '<div class="cf-remain">No positive source → demand match was returned for this output type.</div>'}
          </div>
          <div class="cf-remains">${remains.join("")}</div>
        </div>`;
    }).join("");

    host.innerHTML = `
      <div class="cf-panel-head">
        <div><div class="cf-kick">Output</div><h4>Output-first matching</h4></div>
        <span class="cf-pill">LP match result</span>
      </div>
      ${blocks}
      <div class="cf-foot">
        ${r.status === "Optimal"
          ? `<span class="cf-badge warn">DEMO assumptions</span>
             <span>Yields, operating rates and demand are assumed; the matches come from the backend result.</span>`
          : "<span>Output matching is unavailable because the optimizer did not return an optimal scenario.</span>"}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Recipe engine
  // ---------------------------------------------------------------------------

  function renderRecipe(result, label) {
    lastRecipe = { label, result };

    const top = result.ranked_by_compatibility?.[0];
    const methods = result.methods || {};
    const topMethod = top ? methods[top] : null;
    const fs = result.feedstock_submitted || result.feedstock || {};

    if (!topMethod) {
      setText("recipeState", "Insufficient data");
      setText("recipeConfidence", "no pathway scored");
      return;
    }

    const score = Number(topMethod.compatibility_score ?? 0);
    const verdict =
      topMethod.category === "Compatible" ? "Strong fit" : topMethod.category === "Marginal" ? "Partial fit" : "Poor fit";

    setText("score", Math.round(score));
    const scoreRing = $("scoreRing");
    if (scoreRing) scoreRing.style.background = `conic-gradient(var(--teal) 0 ${score}%, #e0eae5 ${score}% 100%)`;

    setText("recipeInput", label);
    setText("recipeRoute", METHOD_LABELS[top] || prettyId(top));
    setText("recipeOutput", topMethod.category === "Incompatible" ? "limited value" : "recoverable value");

    setText("rfOrganic", fs.organic_fraction == null ? "—" : Math.round(Number(fs.organic_fraction) * 100) + "%");
    setText("rfMoisture", fs.moisture_pct == null ? "—" : fmt(fs.moisture_pct, 0) + "%");
    setText("rfContamination", fs.contamination_pct == null ? "—" : fmt(fs.contamination_pct, 0) + "%");
    setText("rfCn", fs.cn_ratio == null ? "—" : fmt(fs.cn_ratio, 0) + ":1");

    setText("recipeState", verdict);
    setText(
      "recipeConfidence",
      `${String(topMethod.confidence || "UNKNOWN")} confidence · ${topMethod.factors_evaluated || "factor set returned by backend"}`
    );

    const compat = $("recipeCompat");
    if (compat) {
      compat.innerHTML = `
        <span class="${topMethod.category === "Incompatible" ? "warn" : "good"}">${esc(topMethod.category || "Unknown")}</span>
        <span class="good">${esc(topMethod.confidence || "Unknown")} confidence</span>
        <span class="${topMethod.limiting_factors?.length ? "warn" : "good"}">${
          topMethod.limiting_factors?.length ? "watch factors returned" : "✓ no limiting factors"
        }</span>
        <span class="good">advisory only</span>`;
    }

    const compare = $("recipeCompare");
    if (compare) {
      compare.innerHTML = Object.entries(methods)
        .sort((a, b) => Number(b[1].compatibility_score ?? -1) - Number(a[1].compatibility_score ?? -1))
        .map(([key, method]) => {
          const value = Number(method.compatibility_score ?? 0);
          return `
            <div class="cf-tech-row${key === top ? " active" : ""}">
              <b>${esc(METHOD_LABELS[key] || prettyId(key))}</b>
              <div class="cf-tech-track"><i style="width:${pct(value)}%"></i></div>
              <span class="cf-tech-score">${Math.round(value)}</span>
            </div>`;
        })
        .join("");
    }

    const inputs = $("recipeInputs");
    if (inputs) {
      inputs.innerHTML = Object.entries(fs)
        .filter(([key]) => FEEDSTOCK_LABELS[key])
        .map(([key, value]) =>
          `<span class="cf-recipe-input">${esc(FEEDSTOCK_LABELS[key][0])} <b>${esc(FEEDSTOCK_LABELS[key][1](value))}</b></span>`)
        .join("");
    }

    setText("recipeMeterValue", Math.round(score) + "%");
    const meter = $("recipeMeter");
    if (meter) meter.style.width = pct(score) + "%";

    document
      .querySelectorAll("#limitingTitle,#limitingText,.recipe-insight,.recipe-explanation,.limiting-factor")
      .forEach((node) => { node.style.display = "none"; });
  }

  window.runRecipePreset = async function runRecipePreset(key) {
    const preset = RECIPE_PRESETS[key] || RECIPE_PRESETS.mixed;
    const { label, ...feedstock } = preset;
    try {
      const result = await CrossFlowAPI.recipe(feedstock);
      renderRecipe(result, label);
    } catch (err) {
      console.error("recipe fetch failed", err);
      setText("recipeState", "Unavailable");
      setText("recipeConfidence", "API connection required");
    }
  };

  // ---------------------------------------------------------------------------
  // Network pulse (real scenario diversion values from the prefetched runs)
  // ---------------------------------------------------------------------------

  function renderPulse() {
    const panel = $("cfPulsePanel");
    if (!panel) return;

    const rows = Object.keys(SCENARIO_LABELS).map((sid) => {
      const v = heroCache[sid]?.economics?.landfill_diversion_pct?.value;
      return { sid, label: SCENARIO_LABELS[sid], value: v == null ? null : Number(v) };
    });
    const usable = rows.filter((x) => x.value != null);
    if (!usable.length) return;

    const width = 640, height = 150, left = 18, right = 12, top = 14, bottom = 122;
    const step = usable.length > 1 ? (width - left - right) / (usable.length - 1) : 0;
    const y = (value) => bottom - (pct(value) / 100) * (bottom - top);
    const points = usable.map((item, i) => [left + i * step, y(item.value)]);
    const path = points.map(([x, yv], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${yv.toFixed(1)}`).join(" ");
    const area = `${path} L ${points.at(-1)[0]} ${bottom} L ${points[0][0]} ${bottom} Z`;

    const short = (label) =>
      label.replace("Ghazipur outage", "Outage").replace("Festival +20%", "Festival")
        .replace("Monsoon +30%", "Monsoon").replace("Spare capacity", "Spare");

    panel.innerHTML = `
      <div class="panel-head"><h3>Network pulse</h3><span>scenario diversion</span></div>
      <div class="cf-pulse-stage">
        <svg class="cf-pulse-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Scenario diversion comparison">
          <line class="grid" x1="${left}" y1="${y(100)}" x2="${width - right}" y2="${y(100)}"></line>
          <line class="grid" x1="${left}" y1="${y(50)}" x2="${width - right}" y2="${y(50)}"></line>
          <line class="grid" x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}"></line>
          <path class="area" d="${area}"></path>
          <path class="line" d="${path}"></path>
          ${points.map(([x, yv], i) =>
            `<circle class="point${usable[i].sid === lastScenarioId ? " active" : ""}" cx="${x}" cy="${yv}" r="4.2"></circle>`).join("")}
        </svg>
        <div class="cf-pulse-labels">
          ${usable.map((item) =>
            `<div class="cf-pulse-label"><span>${esc(short(item.label))}</span><b>${item.value.toFixed(1)}%</b></div>`).join("")}
        </div>
        <div class="cf-pulse-note">Higher values indicate more landfill diversion under the selected scenario run. The highlighted point is the currently selected scenario.</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------

  function pinSize(node, kind) {
    if (kind === "source") {
      const g = Number(node?.generation_tpd?.value || 0);
      return Math.round(22 + 12 * Math.sqrt(Math.min(1, g / 11500)));
    }
    const c = Number(node?.capacity_tpd?.value || 0);
    return Math.round(26 + 10 * Math.sqrt(Math.min(1, c / 2400)));
  }

  function related(id) {
    // ids that are connected to the selected node by a flow in the current run
    const set = new Set();
    if (!selectedNodeId) return set;
    set.add(selectedNodeId);
    flowLines.forEach(({ src, dst }) => {
      if (src === selectedNodeId) set.add(dst);
      if (dst === selectedNodeId) set.add(src);
    });
    return set;
  }

  function buildPinIcon(id, node, kind) {
    const isSource = kind === "source";
    const size = pinSize(node, kind);
    const cls = ["cf-pin", isSource ? "src" : "fac"];
    let color = isSource ? "#ff7a00" : STATUS_COLORS.steady;
    let glyph = isSource ? "●" : "⚙";
    let badge = "";

    if (isSource) {
      const info = sourceLiveInfo(id);
      if (info?.landfilled > 0) badge = '<span class="lf" title="Landfilling"></span>';
    } else {
      const st = facilityLiveStatus(id);
      if (st) {
        color = st.color;
        if (st.key === "offline") glyph = "✕";
        if (st.binding) cls.push("bound");
      }
    }
    if (selectedNodeId === id) cls.push("sel");
    else if (selectedNodeId && !related().has(id)) cls.push("dim");

    return L.divIcon({
      className: "cf-pin-wrap",
      html: `<span class="${cls.join(" ")}" style="--pc:${color}">${glyph}${badge}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function tooltipHtml(id, node, kind) {
    const name = esc(displayName(id) || node.display_name || id);
    if (kind === "source") {
      const info = sourceLiveInfo(id);
      const sub = info
        ? `${fmt(info.routed)} TPD routed${info.landfilled > 0 ? ` · ${fmt(info.landfilled)} landfilled` : ""}`
        : `${fmt(Number(node?.generation_tpd?.value || 0), 0)} TPD generation`;
      return `<b>${name}</b><span>${sub}</span>`;
    }
    const st = facilityLiveStatus(id);
    const sub = st
      ? `${st.label}${Number.isFinite(st.allocated) ? ` · ${fmt(st.allocated, 0)} TPD` : ""}`
      : `${fmt(Number(node?.capacity_tpd?.value || 0), 0)} TPD nameplate`;
    return `<b>${name}</b><span>${sub}</span>`;
  }

  function buildMapDetailHtml(id) {
    const entry = mapMarkers[id];
    if (!entry) return "";
    const { node, kind } = entry;
    const isSource = kind === "source";
    const name = displayName(id) || node.display_name || "Unnamed node";
    const scenarioLabel = lastScenarioId ? SCENARIO_LABELS[lastScenarioId] || prettyId(lastScenarioId) : "no scenario run yet";
    let body = "";
    let badges = `<span class="cf-badge neutral">${esc(scenarioLabel)}</span>`;

    if (isSource) {
      const info = sourceLiveInfo(id);
      const gen = Number(node?.generation_tpd?.value || 0);
      if (info) {
        const total = info.routed + info.landfilled;
        badges = info.landfilled > 0
          ? `<span class="cf-badge full">${fmt(info.landfilled, 0)} TPD landfilled</span>` + badges
          : `<span class="cf-badge ok">fully routed</span>` + badges;
        const segs = info.parts
          .map((p) => `<i style="flex:${p.tpd};background:${colorOf(p.id)}"></i>`).join("") +
          (info.landfilled > 0 ? `<i style="flex:${info.landfilled};background:${LANDFILL_COLOR}"></i>` : "");
        body = `
          <div class="cf-md-row"><span>Routed this run</span><b>${fmt(info.routed)} TPD</b></div>
          <div class="cf-stack ${total > 0 ? "" : "empty"}">${total > 0 ? segs : ""}</div>
          <div class="cf-md-feeds">${info.parts.map((p) =>
            `<span><i style="background:${colorOf(p.id)}"></i>${esc(shortName(p.id))} ${fmt(p.tpd, 0)}</span>`).join("")}</div>`;
      } else {
        body = `<div class="cf-md-row"><span>Generation</span><b>${fmt(gen, 0)} TPD</b></div>`;
      }
    } else {
      const nameplate = Number(node.capacity_tpd?.value || 0);
      const st = facilityLiveStatus(id);
      body = `<div class="cf-md-row"><span>Nameplate</span><b>${fmt(nameplate, 0)} TPD</b></div>`;
      if (st) {
        const dot = { steady: "ok", rerouted: "warn", offline: "off", built: "build", retrofit: "retrofit" }[st.key] || "neutral";
        badges = `<span class="cf-badge ${dot}">${esc(st.label)}</span>` +
          (st.binding ? '<span class="cf-badge full">Capacity bound</span>' : "") + badges;
        if (st.key === "offline") {
          body += `<div class="cf-md-row"><span>Available this run</span><b>0 TPD (outage)</b></div>`;
        } else if (Number.isFinite(st.allocated) && Number.isFinite(st.base) && st.base > 0) {
          const p = pct((st.allocated / st.base) * 100);
          body += `
            <div class="cf-md-row"><span>Allocated</span><b>${fmt(st.allocated, 0)} / ${fmt(st.base, 0)} TPD</b></div>
            <div class="cf-bar ${st.binding ? "full" : ""}"><i class="used" style="width:${p}%"></i><i class="free" style="width:${100 - p}%"></i></div>`;
        }
        const feeds = [];
        Object.entries(lastResult?.optimizer_result?.flows_tpd || {}).forEach(([k, v]) => {
          const [s, d] = k.split("->");
          if (d === id && Number(v) > 0) feeds.push({ s, v: Number(v) });
        });
        if (feeds.length) {
          body += `<div class="cf-md-feeds">${feeds.map((f) =>
            `<span><i style="background:#ff7a00"></i>${esc(shortName(f.s))} ${fmt(f.v, 0)}</span>`).join("")}</div>`;
        }
      }
    }

    return `
      <div class="cf-md-top">
        <span class="cf-badge ${isSource ? "warn" : "info"}">${isSource ? "Waste source" : "Facility"}</span>
        <button class="cf-md-x" data-close aria-label="Close">×</button>
      </div>
      <b class="cf-md-name">${esc(name)}</b>
      <div class="cf-md-badges">${badges}</div>
      ${body}`;
  }

  function updateMapDetail() {
    const card = $("cfMapDetail");
    if (!card) return;
    if (!selectedNodeId || !mapMarkers[selectedNodeId]) {
      card.classList.remove("open");
      card.innerHTML = "";
      return;
    }
    card.innerHTML = buildMapDetailHtml(selectedNodeId);
    card.classList.add("open");
  }

  function applyFlowStyles() {
    const rel = related();
    flowLines.forEach(({ line, src, dst, weight }) => {
      const hot = selectedNodeId && (src === selectedNodeId || dst === selectedNodeId);
      const dim = selectedNodeId && !hot;
      line.setStyle({ weight: hot ? weight + 1.5 : weight, opacity: dim ? 0.12 : hot ? 1 : 0.72 });
    });
    return rel;
  }

  function drawFlows() {
    if (!window.__crossFlowMap || !flowLayer) return;
    flowLayer.clearLayers();
    flowLines = [];
    const r = lastResult?.optimizer_result;
    if (!r || r.status !== "Optimal") return;

    const entries = Object.entries(r.flows_tpd || {})
      .map(([k, v]) => { const [src, dst] = k.split("->"); return { src, dst, tpd: Number(v) }; })
      .filter((e) => e.tpd > 0 && nodeCoords[e.src] && nodeCoords[e.dst]);
    const maxTpd = Math.max(1, ...entries.map((e) => e.tpd));

    entries.forEach(({ src, dst, tpd }) => {
      const weight = 1.8 + 8 * (tpd / maxTpd);
      const line = L.polyline([nodeCoords[src], nodeCoords[dst]], {
        color: colorOf(dst), weight, opacity: 0.72, lineCap: "round", className: "cf-flow", interactive: true,
      }).addTo(flowLayer);
      line.bindTooltip(
        `<b>${esc(shortName(src))} → ${esc(shortName(dst))}</b><span>${fmt(tpd)} TPD</span>`,
        { sticky: true, className: "cf-tip", opacity: 1 }
      );
      flowLines.push({ line, src, dst, weight });
    });
    applyFlowStyles();
  }

  function selectNode(id) {
    selectedNodeId = id || null;
    refreshMapLiveData();
  }

  function renderMap(net) {
    const el = $("leafletMap");
    if (!el) return net;
    if (typeof L === "undefined") {
      console.warn("Leaflet is not available.");
      return net;
    }

    if (window.__crossFlowMap) {
      window.__crossFlowMap.remove();
      window.__crossFlowMap = null;
    }
    el.style.display = "block";
    el.innerHTML = "";

    const map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 7, maxZoom: 20, worldCopyJump: false });
    window.__crossFlowMap = map;
    mapMarkers = {};
    nodeCoords = {};
    flowLines = [];
    selectedNodeId = null;

    // detail card (overlay, not in document flow)
    $("cfMapDetail")?.remove();
    const mapSection = el.parentElement;
    if (mapSection) {
      const card = document.createElement("div");
      card.id = "cfMapDetail";
      card.className = "cf-map-detail";
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-close]")) selectNode(null);
      });
      mapSection.appendChild(card);
    }

    L.tileLayer("https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · rendering <a href="https://openstreetmap.fr/">OpenStreetMap France</a>',
    }).addTo(map);

    map.setView([28.6139, 77.209], 10.5);
    L.control.zoom({ position: "bottomright" }).addTo(map);

    // flows sit in the overlay pane, below the markers
    flowLayer = L.layerGroup().addTo(map);

    // minimal legend
    const legend = L.control({ position: "topright" });
    legend.onAdd = function () {
      const box = L.DomUtil.create("div", "leaflet-control cf-map-legend");
      box.innerHTML = `
        <div class="cf-lg-row"><span class="cf-lg-ico"><span class="cf-lg-src"></span></span>Waste source</div>
        <div class="cf-lg-row"><span class="cf-lg-ico"><span class="cf-lg-fac"></span></span>Facility</div>
        <div class="cf-lg-row"><span class="cf-lg-ico"><span class="cf-lg-flow"></span></span>Flow · width = TPD</div>
        <div class="cf-lg-sep"></div>
        <div class="cf-lg-dots">
          <span><i style="background:${STATUS_COLORS.steady}"></i>steady</span>
          <span><i style="background:${STATUS_COLORS.rerouted}"></i>rerouted</span>
          <span><i style="background:${STATUS_COLORS.offline}"></i>offline</span>
        </div>
        <div class="cf-lg-note">Locations approximate (demo)</div>`;
      L.DomEvent.disableClickPropagation(box);
      return box;
    };
    legend.addTo(map);

    map.on("click", () => { if (selectedNodeId) selectNode(null); });

    function addNode(node, kind) {
      const c = node?.coordinates;
      if (!c) return null;
      const lat = Number(c.lat);
      const lon = Number(c.lon ?? c.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      nodeCoords[node.id] = [lat, lon];
      const marker = L.marker([lat, lon], {
        icon: buildPinIcon(node.id, node, kind),
        keyboard: true,
        title: displayName(node.id),
        riseOnHover: true,
      }).addTo(map);

      marker.bindTooltip(tooltipHtml(node.id, node, kind), { direction: "top", offset: [0, -10], opacity: 1, className: "cf-tip" });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectNode(selectedNodeId === node.id ? null : node.id);
      });

      mapMarkers[node.id] = { marker, node, kind };
      return [lat, lon];
    }

    const bounds = [];
    (net?.source_nodes || []).forEach((node) => { const p = addNode(node, "source"); if (p) bounds.push(p); });
    (net?.facilities || []).forEach((node) => { const p = addNode(node, "facility"); if (p) bounds.push(p); });

    if (bounds.length >= 2) map.fitBounds(bounds, { padding: [55, 55], maxZoom: 11.5 });

    const stats = $("mapStats");
    if (stats) {
      const sourceCount = (net?.source_nodes || []).length;
      const facilityCount = (net?.facilities || []).length;
      const totalTpd = sum((net?.source_nodes || []).map((n) => n?.generation_tpd?.value));
      stats.innerHTML = `
        <span class="map-chip">${sourceCount} waste sources</span>
        <span class="map-chip">${facilityCount} facilities</span>
        ${totalTpd > 0 ? `<span class="map-chip">${formatCompact(totalTpd)} TPD network</span>` : ""}`;
    }

    setText("mapCaption", "Delhi · approximate locations");

    if (mapSection) {
      mapSection.querySelectorAll(".map-water,.delhi,.route,.zone,.hub,#cfMapPaused").forEach((node) => {
        node.style.display = "none";
      });
    }

    setTimeout(() => map.invalidateSize(true), 250);
    return net;
  }

  // Presentation lookup against already-returned pipeline fields only.
  function refreshMapLiveData() {
    if (!window.__crossFlowMap) return;

    drawFlows();

    Object.entries(mapMarkers).forEach(([id, { marker, node, kind }]) => {
      try {
        marker.setIcon(buildPinIcon(id, node, kind));
        marker.setTooltipContent(tooltipHtml(id, node, kind));
      } catch (err) {
        // never let a map refresh break rendering
      }
    });

    updateMapDetail();

    const r = lastResult?.optimizer_result;
    if (r?.status === "Optimal") {
      const routed = sum(Object.values(r.flows_tpd || {}));
      const landfilled = Number(r.total_landfilled_tpd || 0);
      const stats = $("mapStats");
      if (stats) {
        stats.innerHTML = `
          <span class="map-chip"><b>${fmt(routed, 0)}</b> TPD routed</span>
          <span class="map-chip"><b>${fmt(landfilled, 0)}</b> TPD landfilled</span>
          <span class="map-chip">${Object.keys(mapMarkers).length} nodes</span>`;
      }
      const mi = modeInfo(lastResult.capacity_mode);
      setText("mapCaption", `${SCENARIO_LABELS[lastScenarioId] || prettyId(lastScenarioId)} · ${mi.label}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Run a scenario against the real API.
  // Flow: scenario select / hero bar / Run button -> runScenario() -> CrossFlowAPI.pipeline()
  //       -> renderMain() -> refreshMapLiveData(). Every value on screen comes from that response.
  // ---------------------------------------------------------------------------

  async function runScenario(scenarioId, capacityMode) {
    const scenarioSelect = $("scenario");
    const capacitySelect = $("capacity");
    // guard: when used as a DOM event handler the first argument is an Event, not an id
    const id = (typeof scenarioId === "string" && scenarioId) || scenarioSelect?.value;
    const mode =
      (typeof capacityMode === "string" && capacityMode) || capacitySelect?.value || scenarioDefaults[id];

    if (!id) {
      console.warn("runScenario: no scenario id available (no argument and #scenario select not found)");
      return;
    }

    const seq = ++runSeq;
    const runBtn = document.querySelector(".scenario-bar .btn.primary, #runScenario, [data-action='run-scenario']");
    const originalLabel = runBtn ? runBtn.dataset.label || runBtn.textContent : null;
    if (runBtn) {
      runBtn.dataset.label = originalLabel;
      runBtn.disabled = true;
      runBtn.textContent = "Solving…";
    }
    setStatus("Solving…", true);

    try {
      const natural = scenarioDefaults[id];
      const key = `${id}|${mode}`;
      // Reuse a cached response only when it was fetched at the SAME capacity mode.
      const cached = resultCache[key] || (heroCache[id] && (!mode || mode === natural) ? heroCache[id] : null);
      const result = cached || (await CrossFlowAPI.pipeline(id, { capacityMode: mode }));

      resultCache[key] = result;
      // heroCache feeds the cross-scenario strip/pulse, so it only ever holds natural-mode runs
      if (!natural || !mode || mode === natural) heroCache[id] = result;

      if (seq !== runSeq) return; // a newer run superseded this one
      renderMain(result, id);
      refreshMapLiveData();
    } catch (err) {
      if (seq !== runSeq) return;
      console.error("runScenario failed", id, mode, err);
      clearKpis();
      if (err instanceof CrossFlowAPI.ApiError && err.status === 0) {
        showConnectionError(err);
      } else if (err instanceof CrossFlowAPI.ApiError && err.status === 422) {
        setStatus("Backend declined this run", false);
        setText("decisionTitle", "Backend cannot complete this run (missing data)");
        setText("decisionText", err.message);
      } else {
        setStatus("Scenario error", false);
        setText("decisionTitle", "Could not run this scenario");
        setText("decisionText", (err && err.message) || "The API returned an error for this scenario/capacity-mode combination.");
      }
    } finally {
      if (runBtn && seq === runSeq) {
        runBtn.disabled = false;
        runBtn.textContent = runBtn.dataset.label || "Run →";
      }
    }
  }

  window.runScenario = runScenario;
  window.updateScenario = runScenario; // index.html wires onclick="updateScenario()"

  // Used by the hero bars: keep the capacity select in step with the scenario's natural mode, then run.
  window.selectScenario = function selectScenario(id) {
    const sel = $("scenario");
    if (sel) sel.value = id;
    syncCapacitySelect(id, scenarioDefaults);
    return runScenario(id, scenarioDefaults[id]);
  };

  // ---------------------------------------------------------------------------
  // Scenario prefetch
  // ---------------------------------------------------------------------------

  async function prefetchHero(defaultCapacity) {
    await Promise.all(
      Object.keys(SCENARIO_LABELS).map(async (sid) => {
        try {
          const res = await CrossFlowAPI.pipeline(sid, { capacityMode: defaultCapacity[sid] });
          heroCache[sid] = res;
          resultCache[`${sid}|${defaultCapacity[sid]}`] = res;
        } catch (err) {
          console.warn("scenario prefetch failed", sid, err);
        }
      })
    );
  }

  function syncCapacitySelect(scenarioId, defaults) {
    const select = $("capacity");
    if (select && defaults[scenarioId]) select.value = defaults[scenarioId];
  }

  // ---------------------------------------------------------------------------
  // Init:  scenarios + network fetch -> map -> recipe -> prefetch -> runScenario(initial)
  // ---------------------------------------------------------------------------

  async function init() {
    const status = document.querySelector(".status");
    if (status && !$("apiStatusText")) {
      const dot = status.querySelector(".dot");
      const existing = status.textContent.trim();
      status.innerHTML = "";
      if (dot) status.appendChild(dot);
      const span = document.createElement("span");
      span.id = "apiStatusText";
      span.textContent = existing;
      status.appendChild(span);
    }

    injectCleanSections();
    cleanStaticRecipeUI();
    fixStaticText();
    setStatus("Connecting…", true);

    let scenarios;
    try {
      [scenarios, network] = await Promise.all([CrossFlowAPI.scenarios(), CrossFlowAPI.network()]);
    } catch (err) {
      if (err instanceof CrossFlowAPI.ApiError && err.status !== 0) {
        setStatus("API error", false);
        setText("decisionTitle", "The CrossFlow API returned an error");
        setText("decisionText", err.message || "Check the API server log and reload.");
        return;
      }
      showConnectionError(err);
      return;
    }

    Object.values(scenarios.scenarios || {}).forEach((s) => {
      scenarioDefaults[s.name] = s.capacity_mode;
      scenarioOverrides[s.name] = s.overrides_applied || {};
    });

    facilityNames = {};
    [...(network.source_nodes || []), ...(network.facilities || [])].forEach((node) => {
      facilityNames[node.id] = node.display_name;
    });
    facilityNames.DECENTRALISED_COMPOST = "Decentralised composters & pits";

    renderMap(network);

    const scenarioSelect = $("scenario");
    if (scenarioSelect) {
      scenarioSelect.addEventListener("change", () => syncCapacitySelect(scenarioSelect.value, scenarioDefaults));
      syncCapacitySelect(scenarioSelect.value, scenarioDefaults);
    }

    await runRecipePreset("mixed");

    setStatus("Loading scenarios…", true);
    await prefetchHero(scenarioDefaults);

    // Even if #scenario is missing/misnamed, still render something (baseline) instead of hanging on
    // "Loading scenarios…". Failures end in a visible error state via runScenario's own catch block.
    try {
      const initialId = scenarioSelect ? scenarioSelect.value : "baseline";
      await runScenario(initialId, scenarioDefaults[initialId]);
    } catch (err) {
      console.error("initial runScenario failed unexpectedly", err);
      setStatus("Scenario error", false);
      setText("decisionTitle", "Could not load the initial scenario");
      setText("decisionText", (err && err.message) || "See the browser console for details.");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
