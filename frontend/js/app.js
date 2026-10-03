/**
 * CrossFlow frontend application logic.
 *
 * Uses only the live CrossFlow API for analytical values. This file is presentation-only:
 * it translates backend codes, performs display arithmetic, and renders compact visual summaries.
 * No optimizer, recipe, scenario, economics, or output-matching logic is duplicated here.
 */
(() => {
  "use strict";

  const SCENARIO_LABELS = {
    baseline: "Baseline",
    ghazipur_outage: "Ghazipur outage",
    festival_surge_mcd_20pct: "Festival +20%",
    monsoon_surge_30pct: "Monsoon +30%",
    spare_capacity_demo: "Spare capacity",
  };

  const DECISION_ICON = {
    BUILD: "✦",
    RETROFIT: "⚙",
    REROUTE: "↻",
    DO_NOTHING: "●",
  };

  const DECISIONS = {
    BUILD: {
      label: "Build",
      sub: "Add new capacity",
    },

    RETROFIT: {
      label: "Retrofit",
      sub: "Upgrade existing capacity",
    },

    REROUTE: {
      label: "Reroute",
      sub: "Change the allocation",
    },

    DO_NOTHING: {
      label: "Hold",
      sub: "Keep the current allocation",
    },
  };

  const CAPACITY_MODES = {
    total_network: {
      label: "Total network",
      sub: "Whole network against installed/nameplate capacity",
    },

    incremental_spare: {
      label: "Incremental spare",
      sub: "Additional waste against spare capacity",
    },
  };

  const PROVENANCE = {
    OBSERVED: "Reported",
    DERIVED: "Derived",
    ASSUMED: "Assumed",
    ASSUMPTION: "Assumed",
    MODELLED: "Modelled",
  };

  const METHOD_LABELS = {
    composting: "Composting",
    biomethanation: "Biomethanation",
    waste_to_energy: "Waste-to-energy",
    rdf: "RDF",
  };

  const OUTPUT_LABELS = {
    power_mwh: {
      name: "Recovered power",
      unit: "MWh/day",
    },

    compost_tonnes: {
      name: "Compost",
      unit: "t/day",
    },
  };

  const REASONS = {
    LOWEST_MODELED_LANDED_COST: [
      "Lowest modelled cost",
      "This route has the lowest modelled landed cost.",
    ],

    SHORTEST_MODELED_ROUTE_DISTANCE: [
      "Shortest route",
      "This is the shortest modelled route from the source.",
    ],

    CAPACITY_BINDING_AT_DESTINATION: [
      "Facility full",
      "This facility is at its modelled capacity.",
    ],

    LOWER_MODELED_COST_OPTION_UNAVAILABLE: [
      "Cheaper option unavailable",
      null,
    ],

    LOWER_MODELED_COST_OPTION_CAPACITY_BINDING: [
      "Cheaper option full",
      null,
    ],

    LOWER_MODELED_COST_OPTION_NOT_SELECTED_BY_SOLVER: [
      "Cheaper option not chosen",
      null,
    ],

    ALL_OPERATING_FACILITY_CAPACITY_EXHAUSTED: [
      "All capacity used",
      "Operating facility capacity is exhausted.",
    ],

    RESIDUAL_ALLOCATION_TO_LANDFILL: [
      "Residual to landfill",
      "This remainder was not assigned to a more suitable destination.",
    ],

    OUTAGE_CAUSED_REROUTE: [
      "Rerouted by outage",
      null,
    ],

    ALLOCATION_CHANGED_DUE_TO_SCENARIO_INPUT_CHANGE: [
      "Allocation changed",
      "Waste generation changed under this scenario.",
    ],

    NO_CHANGE_FROM_BASELINE_ALLOCATION: [
      "No change",
      "This facility keeps its baseline allocation.",
    ],

    CAPACITY_BINDING: [
      "At capacity",
      "This facility is at its modelled capacity.",
    ],

    BUILD_CHOSEN_WITHIN_BUDGET: [
      "Build chosen",
      null,
    ],

    RETROFIT_CHOSEN_WITHIN_BUDGET: [
      "Retrofit chosen",
      null,
    ],
  };

  const RECIPE_PRESETS = {
    mixed: {
      label: "Mixed MSW",
      organic_fraction: 0.4,
      moisture_pct: 55,
      contamination_pct: 12,
      cn_ratio: 28,
    },

    wet: {
      label: "Wet organics",
      organic_fraction: 0.72,
      moisture_pct: 68,
      contamination_pct: 6,
      cn_ratio: 24,
    },

    dry: {
      label: "Dry recoverables",
      organic_fraction: 0.22,
      moisture_pct: 18,
      contamination_pct: 15,
      cn_ratio: 55,
    },

    highmoisture: {
      label: "Surge mix",
      organic_fraction: 0.45,
      moisture_pct: 78,
      contamination_pct: 14,
      cn_ratio: 30,
    },
  };

  const FEEDSTOCK_LABELS = {
    organic_fraction: [
      "Organic",
      (v) => Math.round(v * 100) + "%",
    ],

    moisture_pct: [
      "Moisture",
      (v) => v + "%",
    ],

    contamination_pct: [
      "Contamination",
      (v) => v + "%",
    ],

    cn_ratio: [
      "C:N",
      (v) => v + ":1",
    ],
  };

  let facilityNames = {};
  let network = null;
  let heroCache = {};
  let lastResult = null;
  let lastScenarioId = null;
  let lastRecipe = null;
  let scenarioDefaults = {}; // scenario id -> its natural capacity_mode, from /api/scenarios
  let mapMarkers = {}; // node id -> { marker, node, kind } -- for live per-scenario popup/style refresh

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  function fmt(value, digits = 1) {
    if (
      value == null ||
      Number.isNaN(Number(value))
    ) {
      return "—";
    }

    return Number(value).toLocaleString(
      undefined,
      {
        maximumFractionDigits: digits,
      }
    );
  }

  function formatCompact(value) {
    if (
      value == null ||
      Number.isNaN(Number(value))
    ) {
      return "—";
    }

    const n = Number(value);
    const a = Math.abs(n);

    if (a >= 1e9) {
      return (
        n / 1e9
      ).toFixed(2) + "B";
    }

    if (a >= 1e6) {
      return (
        n / 1e6
      ).toFixed(2) + "M";
    }

    if (a >= 1e3) {
      return (
        n / 1e3
      ).toFixed(1) + "K";
    }

    return n.toFixed(0);
  }

  function prettyId(value) {
    if (!value) {
      return "—";
    }

    return String(value)
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(
        /\b\w/g,
        (c) => c.toUpperCase()
      );
  }

  function displayName(id) {
    return (
      facilityNames[id] ||
      prettyId(id)
    );
  }

  function modeInfo(mode) {
    return (
      CAPACITY_MODES[mode] || {
        label: prettyId(mode),
        sub: "",
      }
    );
  }

  function provenance(label) {
    return (
      PROVENANCE[label] ||
      label ||
      ""
    );
  }

  function titleCaseDecision(
    decision
  ) {
    return (
      DECISIONS[decision]?.label ||
      prettyId(decision)
    );
  }

  function pickHeadline(
    decisions = {}
  ) {
    const entries =
      Object.entries(
        decisions
      );

    if (!entries.length) {
      return {
        fid: null,
        decision: null,
        allStable: false,
      };
    }

    const changed =
      entries.find(
        ([, d]) =>
          d !== "DO_NOTHING"
      );

    const [
      fid,
      decision,
    ] =
      changed ||
      entries[0];

    return {
      fid,
      decision,
      allStable:
        entries.every(
          ([, d]) =>
            d ===
            "DO_NOTHING"
        ),
    };
  }

  function humanizeReason(
    raw
  ) {
    const str =
      String(raw || "");

    const match =
      str.match(
        /^([A-Z][A-Z_]+)/
      );

    const code =
      match
        ? match[1]
        : "";

    const entry =
      REASONS[code];

    if (!entry) {
      return {
        title:
          prettyId(code) ||
          "Reason",

        text:
          str
            .slice(
              code.length
            )
            .replace(
              /^[:\s]+/,
              ""
            ),
      };
    }

    const colon =
      str.indexOf(":");

    const detail =
      colon >= 0
        ? str
            .slice(
              colon + 1
            )
            .trim()
        : "";

    return {
      title:
        entry[0],

      text:
        entry[1] ||
        detail ||
        entry[0],
    };
  }

  function setText(
    id,
    value
  ) {
    const node =
      document.getElementById(
        id
      );

    if (node) {
      node.textContent =
        value;
    }
  }

  function setStatus(
    message,
    ok = true
  ) {
    const dot =
      document.querySelector(
        ".status .dot"
      );

    const label =
      document.getElementById(
        "apiStatusText"
      );

    if (dot) {
      dot.classList.toggle(
        "offline",
        !ok
      );
    }

    if (label) {
      label.textContent =
        message;
    }
  }

  function showConnectionError(
    err
  ) {
    setStatus(
      "⚠ API offline",
      false
    );

    setText(
      "decisionTitle",
      "Can't reach the CrossFlow API"
    );

    setText(
      "decisionText",
      err?.message ||
        "Start the API server from localloop/backend and reload."
    );

    const reasonLine =
      document.getElementById(
        "reasonLine"
      );

    if (reasonLine) {
      reasonLine.innerHTML =
        '<span class="reason">NO CONNECTION</span>';
    }

    [
      "throughput",
      "landfill",
      "diversion",
      "power",
    ].forEach(
      (id) =>
        setText(
          id,
          "—"
        )
    );
  }

  // ---------------------------------------------------------------------------
  // Visual styling
  // ---------------------------------------------------------------------------

  const CF_CSS = `
    .cf-clean{
      margin-top:16px;
    }

    /* =========================================================
       Decision chain
       ========================================================= */

    .cf-chainbar{
      display:grid;
      grid-template-columns:repeat(4,1fr);
      gap:10px;
      padding:0;
      margin-bottom:14px;
    }

    .cf-chainitem{
      position:relative;
      padding:13px 14px;
      background:#fff;
      border:1px solid var(--line);
      border-radius:18px;
      min-width:0;
      box-shadow:0 8px 20px rgba(31,70,55,.04);
    }

    .cf-chainitem:not(:last-child)::after{
      content:'→';
      position:absolute;
      right:-10px;
      top:50%;
      transform:translateY(-50%);
      color:#95a89f;
      font-weight:900;
      background:var(--bg);
      padding:0 2px;
      z-index:2;
      font-size:12px;
    }

    .cf-chainitem small{
      display:block;
      font-size:7px;
      letter-spacing:.11em;
      text-transform:uppercase;
      color:#8a9b93;
      font-weight:900;
    }

    .cf-chainitem b{
      display:block;
      margin-top:6px;
      font-size:13px;
      line-height:1.15;
      color:var(--teal-dark);
    }

    .cf-chainitem span{
      display:block;
      margin-top:5px;
      font-size:8px;
      color:#70857b;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    /* =========================================================
       Main decision intelligence grid
       ========================================================= */

    .cf-dashboard-grid{
      display:grid;
      grid-template-columns:.9fr 1.1fr;
      gap:14px;
      align-items:start;
    }

    .cf-left-stack{
      display:grid;
      gap:14px;
      min-width:0;
    }

    .cf-panel{
      background:#fff;
      border:1px solid var(--line);
      border-radius:22px;
      padding:18px;
      min-width:0;
      box-shadow:0 10px 25px rgba(31,70,55,.045);
    }

    .cf-panel-head{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
    }

    .cf-panel-head h4{
      margin:0;
      font-size:17px;
      line-height:1.2;
      letter-spacing:-.025em;
    }

    .cf-panel-head p{
      margin:5px 0 0;
      font-size:9px;
      line-height:1.5;
      color:#71857b;
      max-width:560px;
    }

    .cf-pill{
      display:inline-flex;
      padding:6px 9px;
      border-radius:999px;
      background:#eef7f2;
      border:1px solid #d4e8df;
      color:var(--teal-dark);
      font-size:7px;
      font-weight:900;
      white-space:nowrap;
    }

    /* =========================================================
       Capacity
       ========================================================= */

    .cf-cap-summary{
      display:grid;
      grid-template-columns:1.1fr .9fr .9fr;
      gap:8px;
      margin:15px 0 13px;
    }

    .cf-cap-stat{
      padding:10px 11px;
      border:1px solid #e1ebe6;
      border-radius:13px;
      background:#f9fcfa;
    }

    .cf-cap-stat span{
      display:block;
      font-size:6.5px;
      color:#85978f;
      text-transform:uppercase;
      letter-spacing:.09em;
      font-weight:900;
    }

    .cf-cap-stat b{
      display:block;
      margin-top:4px;
      font-size:17px;
      color:var(--ink);
      letter-spacing:-.035em;
    }

    .cf-cap-stat small{
      display:block;
      margin-top:2px;
      color:#84958e;
      font-size:6.5px;
    }

    .cf-cap-summary .accent b{
      color:var(--teal-dark);
    }

    .cf-cap-total-bar{
      height:11px;
      display:flex;
      overflow:hidden;
      border-radius:999px;
      background:#e7eeea;
      margin:4px 0 6px;
    }

    .cf-cap-total-bar i{
      display:block;
      height:100%;
    }

    .cf-cap-total-bar .used{
      background:
        linear-gradient(
          90deg,
          var(--teal),
          #67c8ae
        );
    }

    .cf-cap-total-bar .free{
      background:#deefe7;
    }

    .cf-cap-total-bar .load{
      background:
        repeating-linear-gradient(
          45deg,
          #c5d1ca,
          #c5d1ca 4px,
          #d5dfda 4px,
          #d5dfda 8px
        );
    }

    .cf-cap-row{
      padding:10px 11px;
      border:1px solid #e0eae5;
      border-radius:14px;
      margin-top:8px;
      background:#fff;
    }

    .cf-cap-row-top{
      display:flex;
      justify-content:space-between;
      align-items:baseline;
      gap:10px;
      font-size:9px;
      color:#667970;
    }

    .cf-cap-row-top b{
      color:var(--ink);
      font-size:10px;
    }

    .cf-cap-row-top small{
      font-size:7px;
      color:#7d9087;
      white-space:nowrap;
    }

    .cf-cap-bar{
      height:8px;
      border-radius:999px;
      overflow:hidden;
      background:#e8efeb;
      display:flex;
      margin:7px 0 6px;
    }

    .cf-cap-bar i{
      display:block;
      height:100%;
    }

    .cf-cap-bar .used{
      background:
        linear-gradient(
          90deg,
          var(--teal),
          #73ceb6
        );
    }

    .cf-cap-bar .free{
      background:#deefe7;
    }

    .cf-cap-bar .load{
      background:
        repeating-linear-gradient(
          45deg,
          #c7d2cc,
          #c7d2cc 4px,
          #d6dfda 4px,
          #d6dfda 8px
        );
    }

    .cf-cap-foot{
      margin-top:11px;
      padding-top:10px;
      border-top:1px solid #e9efec;
      font-size:7.5px;
      line-height:1.45;
      color:#7a8d84;
    }

    /* =========================================================
       Why this move
       ========================================================= */

    .cf-why-top{
      display:grid;
      grid-template-columns:42px 1fr auto;
      gap:11px;
      align-items:center;
      margin-top:15px;
      padding-bottom:11px;
      border-bottom:1px solid #e6eee9;
    }

    .cf-why-icon{
      width:42px;
      height:42px;
      border-radius:13px;
      display:grid;
      place-items:center;
      background:#eef8f3;
      border:1px solid #d1e8de;
      color:var(--teal-dark);
      font-size:17px;
      font-weight:900;
    }

    .cf-why-title b{
      display:block;
      font-size:13px;
      line-height:1.2;
    }

    .cf-why-title span{
      display:block;
      margin-top:3px;
      font-size:7.5px;
      line-height:1.4;
      color:#7e9089;
    }

    .cf-why-meta{
      display:flex;
      gap:6px;
      flex-wrap:wrap;
      margin-top:9px;
    }

    .cf-why-chip{
      padding:5px 7px;
      border-radius:999px;
      background:#f7faf8;
      border:1px solid #dfeae5;
      color:#5f776d;
      font-size:6.5px;
      font-weight:900;
      letter-spacing:.04em;
      text-transform:uppercase;
    }

    .cf-why-trace{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:8px;
      margin-top:11px;
    }

    .cf-trace-card{
      position:relative;
      min-height:92px;
      padding:11px;
      border:1px solid #e1ebe6;
      border-radius:14px;
      background:#fff;
    }

    .cf-trace-card:not(:last-child)::after{
      content:'→';
      position:absolute;
      right:-10px;
      top:31px;
      width:18px;
      height:18px;
      display:grid;
      place-items:center;
      border-radius:50%;
      border:1px solid #d9e7e1;
      background:#fff;
      color:#8aa197;
      font-size:9px;
      z-index:2;
    }

    .cf-trace-no{
      font-size:6.5px;
      color:#97a7a0;
      letter-spacing:.1em;
      text-transform:uppercase;
      font-weight:900;
    }

    .cf-trace-card b{
      display:block;
      margin-top:5px;
      font-size:10px;
      color:var(--ink);
    }

    .cf-trace-card span{
      display:block;
      margin-top:4px;
      font-size:7px;
      line-height:1.4;
      color:#788b82;
    }

    .cf-why-foot{
      margin-top:10px;
      padding-top:9px;
      border-top:1px solid #e8efec;
      font-size:7px;
      line-height:1.45;
      color:#82938b;
    }

    .cf-why-foot b{
      color:var(--teal-dark);
    }

    /* =========================================================
       Output-first matching
       ========================================================= */

    .cf-matching-panel{
      min-height:100%;
    }

    .cf-output-summary{
      display:grid;
      grid-template-columns:1.15fr .9fr .9fr;
      gap:8px;
      margin-top:15px;
    }

    .cf-output-stat{
      padding:11px 12px;
      border:1px solid #e0ebe6;
      border-radius:14px;
      background:#fbfdfc;
    }

    .cf-output-stat.main{
      background:
        linear-gradient(
          145deg,
          #eef9f4,
          #f8fcfa
        );
      border-color:#cfe8dd;
    }

    .cf-output-stat span{
      display:block;
      font-size:6.5px;
      text-transform:uppercase;
      letter-spacing:.09em;
      color:#81938b;
      font-weight:900;
    }

    .cf-output-stat b{
      display:block;
      margin-top:5px;
      font-size:20px;
      letter-spacing:-.04em;
      color:var(--ink);
    }

    .cf-output-stat.main b{
      color:var(--teal-dark);
    }

    .cf-output-stat small{
      display:block;
      margin-top:2px;
      font-size:6.5px;
      color:#84958d;
    }

    .cf-output-meters{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:8px;
      margin-top:9px;
    }

    .cf-output-meter{
      padding:9px 10px;
      border:1px solid #e1ebe6;
      border-radius:13px;
      background:#f8fbf9;
    }

    .cf-output-meter-head{
      display:flex;
      justify-content:space-between;
      align-items:baseline;
      gap:8px;
      color:#71857b;
      font-size:7px;
    }

    .cf-output-meter-head b{
      font-size:10px;
      color:var(--teal-dark);
    }

    .cf-output-track{
      height:8px;
      border-radius:999px;
      background:#e5ece8;
      overflow:hidden;
      margin-top:6px;
    }

    .cf-output-track i{
      display:block;
      height:100%;
      border-radius:inherit;
      background:
        linear-gradient(
          90deg,
          var(--teal),
          #75ceb6
        );
    }

    .cf-output-track i.alt{
      background:
        linear-gradient(
          90deg,
          #7ea8c8,
          #4b78a5
        );
    }

    .cf-output-block{
      margin-top:12px;
      padding-top:12px;
      border-top:1px solid #e7efeb;
    }

    .cf-output-block-head{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
    }

    .cf-output-block-head b{
      font-size:12px;
    }

    .cf-output-block-head span{
      font-size:6.5px;
      padding:4px 6px;
      border-radius:999px;
      background:#f1f7f4;
      color:#5c756b;
      border:1px solid #dfebe5;
    }

    .cf-match-ledger{
      display:grid;
      gap:6px;
      margin-top:8px;
    }

    .cf-match-row{
      display:grid;
      grid-template-columns:
        minmax(110px,1fr)
        18px
        minmax(100px,1fr)
        72px;
      align-items:center;
      gap:6px;
      padding:8px 9px;
      border:1px solid #e2ebe7;
      border-radius:11px;
      background:#fff;
    }

    .cf-match-node b{
      display:block;
      font-size:8px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }

    .cf-match-node small{
      display:block;
      margin-top:2px;
      font-size:6.5px;
      color:#889991;
    }

    .cf-match-arrow{
      text-align:center;
      color:#8ca198;
      font-size:11px;
    }

    .cf-match-qty{
      text-align:right;
    }

    .cf-match-qty b{
      display:block;
      font-size:9px;
      color:var(--teal-dark);
    }

    .cf-match-qty small{
      display:block;
      font-size:6px;
      color:#8a9993;
      margin-top:2px;
    }

    .cf-remains{
      display:flex;
      gap:6px;
      flex-wrap:wrap;
      margin-top:7px;
    }

    .cf-remain{
      padding:5px 7px;
      border:1px solid #e1e9e5;
      border-radius:999px;
      background:#f8fbf9;
      font-size:6.5px;
      color:#71837b;
    }

    .cf-remain b{
      color:var(--ink);
    }

    .cf-match-note{
      margin-top:9px;
      font-size:7px;
      line-height:1.45;
      color:#82938b;
    }

    /* =========================================================
       Recipe
       ========================================================= */

    .recipe{
      margin-top:15px;
    }

    .recipe-title h3{
      font-size:21px;
    }

    .recipe-title p{
      font-size:9.5px;
      max-width:680px;
    }

    .recipe-stage{
      gap:12px;
    }

    .recipe-journey{
      padding:17px;
    }

    .journey-title{
      font-size:18px;
    }

    .j-node{
      min-height:78px;
    }

    .j-node b{
      font-size:8px;
    }

    .j-node span{
      font-size:7px;
    }

    .factor{
      padding:13px;
    }

    .factor-head{
      font-size:9px;
    }

    .factor-head b{
      font-size:12px;
    }

    .factor small{
      font-size:7.5px;
    }

    .recipe-side{
      padding:22px;
    }

    .recipe-side .mini-label{
      font-size:7.5px;
    }

    .verdict b{
      font-size:16px;
    }

    .recipe-side h4{
      font-size:8px;
    }

    .recipe-side p{
      font-size:9.5px;
    }

    .compat span{
      font-size:7.5px;
    }

    .recipe-note{
      font-size:7.5px;
    }

    .recipe-insight{
      display:none !important;
    }

    #limitingTitle,
    #limitingText,
    #recipeTextOld,
    .recipe-insight,
    .recipe-explanation,
    .limiting-factor{
      display:none !important;
    }

    .cf-recipe-compare{
      margin-top:13px;
      padding-top:12px;
      border-top:1px solid rgba(255,255,255,.11);
    }

    .cf-recipe-compare-head{
      display:flex;
      justify-content:space-between;
      gap:8px;
      font-size:7px;
      color:#a7c4b8;
      text-transform:uppercase;
      letter-spacing:.1em;
      font-weight:900;
    }

    .cf-tech-row{
      display:grid;
      grid-template-columns:116px 1fr 34px;
      gap:8px;
      align-items:center;
      margin-top:9px;
    }

    .cf-tech-row b{
      font-size:8px;
      color:#f0f8f4;
    }

    .cf-tech-row.active b{
      color:#dff6ad;
    }

    .cf-tech-track{
      height:7px;
      border-radius:999px;
      background:rgba(255,255,255,.09);
      overflow:hidden;
    }

    .cf-tech-track i{
      display:block;
      height:100%;
      border-radius:inherit;
      background:
        linear-gradient(
          90deg,
          #b7e76b,
          #58d1b2
        );
    }

    .cf-tech-score{
      font-size:8px;
      text-align:right;
      color:#c8ddd4;
      font-weight:900;
    }

    .cf-recipe-inputs{
      display:flex;
      gap:6px;
      flex-wrap:wrap;
      margin-top:10px;
    }

    .cf-recipe-input{
      padding:6px 8px;
      border-radius:999px;
      background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.1);
      font-size:7px;
      color:#b9cec5;
    }

    .cf-recipe-input b{
      color:#eef8f4;
    }

    /* =========================================================
       Network pulse
       ========================================================= */

    #cfPulsePanel{
      padding:18px;
    }

    .cf-pulse-stage{
      margin-top:12px;
      padding:12px 12px 10px;
      border:1px solid #e0ebe5;
      border-radius:16px;
      background:#fbfdfc;
    }

    .cf-pulse-chart{
      width:100%;
      height:150px;
      display:block;
    }

    .cf-pulse-chart .grid{
      stroke:#e4ece8;
      stroke-width:1;
    }

    .cf-pulse-chart .area{
      fill:rgba(21,155,131,.08);
    }

    .cf-pulse-chart .line{
      fill:none;
      stroke:var(--teal);
      stroke-width:3;
      stroke-linecap:round;
      stroke-linejoin:round;
    }

    .cf-pulse-chart .point{
      fill:#fff;
      stroke:var(--teal);
      stroke-width:2.5;
    }

    .cf-pulse-chart .point.active{
      fill:var(--lime);
      stroke:#6c9b2a;
    }

    .cf-pulse-labels{
      display:grid;
      grid-template-columns:repeat(5,1fr);
      gap:5px;
      margin-top:7px;
    }

    .cf-pulse-label{
      text-align:center;
      font-size:6.5px;
      color:#7f9189;
    }

    .cf-pulse-label b{
      display:block;
      font-size:8px;
      color:var(--ink);
      margin-top:2px;
    }

    .cf-pulse-note{
      margin-top:8px;
      font-size:7px;
      line-height:1.45;
      color:#7f9189;
    }

    /* =========================================================
       Flatten the large thinking dial
       ========================================================= */

    .thinking-final{
      margin-top:18px !important;
    }

    .thinking-final .decision-dial-wrap{
      padding:18px !important;
    }

    .thinking-final .decision-dial{
      height:auto !important;
      min-height:0 !important;
      border-radius:20px !important;
      background:
        linear-gradient(
          145deg,
          #fff,
          #f1f8f4
        ) !important;
      box-shadow:none !important;
      overflow:visible !important;

      display:grid !important;
      grid-template-columns:
        repeat(7,minmax(0,1fr)) !important;
      gap:8px !important;
      padding:0 !important;
    }

    .thinking-final .dial-track,
    .thinking-final .dial-halo,
    .thinking-final .dial-tick,
    .thinking-final .dial-core{
      display:none !important;
    }

    .thinking-final .dial-node{
      position:relative !important;
      inset:auto !important;
      transform:none !important;
      width:auto !important;
      height:auto !important;
      min-height:86px !important;
      border-radius:15px !important;
      background:#fff !important;
      border:1px solid var(--line) !important;
      box-shadow:none !important;
      padding:10px !important;
    }

    .thinking-final .dial-node.active{
      border-color:#bfe3d3 !important;
      background:#eef9f4 !important;
    }

    .thinking-final .dial-icon{
      width:30px !important;
      height:30px !important;
      display:grid !important;
      place-items:center !important;
      margin:6px auto 5px !important;
      border-radius:9px !important;
      background:var(--mint) !important;
      color:var(--teal) !important;
    }

    .thinking-final .dial-num{
      display:block !important;
      font-size:6px !important;
    }

    .thinking-final .dial-node b{
      font-size:7.5px !important;
    }

    .thinking-final .dial-node small{
      font-size:6.5px !important;
    }

    /* =========================================================
       Responsive
       ========================================================= */

    @media(max-width:1180px){
      .cf-dashboard-grid{
        grid-template-columns:1fr;
      }

      .cf-chainbar{
        grid-template-columns:1fr 1fr;
      }

      .cf-chainitem:not(:last-child)::after{
        display:none;
      }

      .cf-output-summary{
        grid-template-columns:1fr 1fr;
      }

      .cf-output-summary .main{
        grid-column:1/-1;
      }

      .thinking-final .decision-dial{
        grid-template-columns:
          repeat(4,minmax(0,1fr)) !important;
      }
    }

    @media(max-width:760px){
      .cf-chainbar{
        grid-template-columns:1fr;
      }

      .cf-cap-summary,
      .cf-output-summary,
      .cf-output-meters{
        grid-template-columns:1fr;
      }

      .cf-output-summary .main{
        grid-column:auto;
      }

      .cf-why-trace{
        grid-template-columns:1fr;
      }

      .cf-trace-card:not(:last-child)::after{
        content:'↓';
        right:calc(50% - 8px);
        top:auto;
        bottom:-10px;
      }

      .cf-match-row{
        grid-template-columns:
          1fr
          auto;
      }

      .cf-match-arrow{
        display:none;
      }

      .cf-match-qty{
        text-align:left;
      }

      .cf-pulse-labels{
        grid-template-columns:1fr 1fr;
      }

      .thinking-final .decision-dial{
        grid-template-columns:
          repeat(2,minmax(0,1fr)) !important;
      }
    }
  `;

  // ---------------------------------------------------------------------------
  // Dynamic sections
  // ---------------------------------------------------------------------------

  function injectCleanSections() {
    if (
      !document.getElementById(
        "cfCleanSection"
      )
    ) {
      const style =
        document.createElement(
          "style"
        );

      style.textContent =
        CF_CSS;

      document.head.appendChild(
        style
      );

      const section =
        document.createElement(
          "section"
        );

      section.id =
        "cfCleanSection";

      section.className =
        "cf-clean";

      section.innerHTML = `
        <div class="cf-chainbar">

          <div class="cf-chainitem">
            <small>
              01 · Recipe
            </small>

            <b id="cfChainRecipe">
              —
            </b>

            <span id="cfChainRecipeText">
              Feedstock fit
            </span>
          </div>

          <div class="cf-chainitem">
            <small>
              02 · Capacity
            </small>

            <b id="cfChainCapacity">
              —
            </b>

            <span id="cfChainCapacityText">
              Usable room
            </span>
          </div>

          <div class="cf-chainitem">
            <small>
              03 · Optimizer
            </small>

            <b id="cfChainDecision">
              —
            </b>

            <span id="cfChainDecisionText">
              Network action
            </span>
          </div>

          <div class="cf-chainitem">
            <small>
              04 · Output
            </small>

            <b id="cfChainOutput">
              —
            </b>

            <span id="cfChainOutputText">
              Useful recovery
            </span>
          </div>

        </div>

        <div class="cf-dashboard-grid">

          <div class="cf-left-stack">

            <article
              class="cf-panel"
              id="cfCapacityPanel"
            ></article>

            <article
              class="cf-panel"
              id="cfWhyPanel"
            ></article>

          </div>

          <article
            class="cf-panel cf-matching-panel"
            id="cfMatchingPanel"
          ></article>

        </div>
      `;

      const main =
        document.querySelector(
          "section.main"
        );

      if (
        main?.parentNode
      ) {
        main.parentNode.insertBefore(
          section,
          main.nextSibling
        );
      }
    }

}

  // ---------------------------------------------------------------------------
  // Recipe cleanup
  // ---------------------------------------------------------------------------

  function cleanStaticRecipeUI() {
    const title =
      document.querySelector(
        ".recipe-title h3"
      );

    const copy =
      document.querySelector(
        ".recipe-title p"
      );

    const journeyTitle =
      document.querySelector(
        ".journey-title"
      );

    const side =
      document.querySelector(
        ".recipe-side"
      );

    const recipeTag =
      document.querySelector(
        ".recipe-controls .badge-pop"
      );

    if (title) {
      title.textContent =
        "♻ Feedstock compatibility";
    }

    if (copy) {
      copy.textContent =
        "Test the waste profile first. The Recipe Engine scores pathway fit; the optimizer remains independent.";
    }

    if (journeyTitle) {
      journeyTitle.textContent =
        "What fits this feedstock?";
    }

    if (recipeTag) {
      recipeTag.innerHTML =
        "<strong>advisory layer</strong> · solver stays independent";
    }

    // Remove the old explanatory copy.
    document
      .querySelectorAll(
        ".recipe-insight,#limitingTitle,#limitingText,.recipe-explanation,.limiting-factor"
      )
      .forEach(
        (node) => {
          node.style.display =
            "none";
        }
      );

    const recipeText =
      document.getElementById(
        "recipeText"
      );

    if (recipeText) {
      recipeText.textContent =
        "The selected pathway is a feedstock-compatibility signal, not a solver instruction.";
    }

    // Turn the old factor boxes into actual input values.
    const recipeFactors =
      document.querySelector(
        ".recipe-factors"
      );

    if (recipeFactors) {
      recipeFactors.innerHTML = `
        <div class="factor">
          <span class="factor-badge">
            INPUT
          </span>

          <div class="factor-head">
            <span>
              Organic fraction
            </span>

            <b id="rfOrganic">
              —
            </b>
          </div>

          <small>
            submitted feedstock value
          </small>
        </div>

        <div class="factor">
          <span class="factor-badge">
            INPUT
          </span>

          <div class="factor-head">
            <span>
              Moisture
            </span>

            <b id="rfMoisture">
              —
            </b>
          </div>

          <small>
            submitted feedstock value
          </small>
        </div>

        <div class="factor">
          <span class="factor-badge">
            INPUT
          </span>

          <div class="factor-head">
            <span>
              Contamination
            </span>

            <b id="rfContamination">
              —
            </b>
          </div>

          <small>
            submitted feedstock value
          </small>
        </div>

        <div class="factor">
          <span class="factor-badge">
            INPUT
          </span>

          <div class="factor-head">
            <span>
              C:N ratio
            </span>

            <b id="rfCn">
              —
            </b>
          </div>

          <small>
            submitted feedstock value
          </small>
        </div>
      `;
    }

    // Replace recipe-side panel so the detailed explanation
    // has one home only.
    if (side) {
      side.innerHTML = `
        <div class="mini-label">
          Compatibility signal
        </div>

        <div class="verdict">

          <div class="verdict-dot">
            ✓
          </div>

          <div>
            <b id="recipeState">
              —
            </b>

            <span id="recipeConfidence">
              —
            </span>
          </div>

        </div>

        <div
          class="compat"
          id="recipeCompat"
        ></div>

        <div class="cf-recipe-compare">

          <div class="cf-recipe-compare-head">
            <span>
              Technology comparison
            </span>

            <span>
              / 100
            </span>
          </div>

          <div
            id="recipeCompare"
          ></div>

        </div>

        <div
          class="cf-recipe-inputs"
          id="recipeInputs"
        ></div>

        <div class="recipe-meter">

          <div class="meter-line">
            <span>
              Top pathway compatibility
            </span>

            <b id="recipeMeterValue">
              —
            </b>
          </div>

          <div class="meter">
            <i
              id="recipeMeter"
              style="width:0%"
            ></i>
          </div>

        </div>

        <div class="recipe-note">
          <b>
            Boundary:
          </b>

          recipe fit explains the stream;
          it never silently changes the network allocation.
        </div>
      `;
    }

    // Keep the journey labels honest.
    const nodes =
      document.querySelectorAll(
        ".journey-path .j-node"
      );

    if (nodes.length >= 3) {
      nodes[0]
        .querySelector(
          "b"
        )
        .textContent =
        "INPUT";

      nodes[1]
        .querySelector(
          "b"
        )
        .textContent =
        "BEST FIT";

      nodes[2]
        .querySelector(
          "b"
        )
        .textContent =
        "VALUE";
    }
  }

  // ---------------------------------------------------------------------------
  // Static labels
  // ---------------------------------------------------------------------------

  function fixStaticText() {
    const modeNote =
      document.querySelector(
        ".mode-note div span"
      );

    if (modeNote) {
      modeNote.textContent =
        "live API · evidence-labelled values";
    }

    const footer =
      document.querySelector(
        ".footer"
      );

    if (footer) {
      footer.textContent =
        "CrossFlow figures are served by the live API. Prototype assumptions are explicitly labelled; recipe presets are example inputs.";
    }

    document
      .querySelectorAll(
        ".analytics .panel"
      )
      .forEach(
        (panel) => {
          const heading =
            panel.querySelector(
              ".panel-head h3"
            );

          if (
            heading?.textContent
              .trim()
              .toLowerCase() ===
            "network pulse"
          ) {
            panel.id =
              "cfPulsePanel";
          }
        }
      );

    const pulseLabel =
      document.querySelector(
        "#cfPulsePanel .panel-head span"
      );

    if (pulseLabel) {
      pulseLabel.textContent =
        "scenario diversion";
    }
  }

  // ---------------------------------------------------------------------------
  // Hero scenario strip
  // ---------------------------------------------------------------------------

  function renderHeroStrip(
    selectedScenario
  ) {
    const chart =
      document.getElementById(
        "scenarioChart"
      );

    if (!chart) {
      return;
    }

    chart
      .querySelectorAll(
        ".scenario-bar-col"
      )
      .forEach(
        (col) => {
          const sid =
            col.dataset
              .scenario;

          const cached =
            heroCache[sid];

          const fill =
            col.querySelector(
              ".scenario-bar-fill"
            );

          const value =
            col.querySelector(
              ".scenario-bar-value"
            );

          col.classList.toggle(
            "active",
            sid ===
              selectedScenario
          );

          if (
            !cached?.economics
          ) {
            return;
          }

          const diversion =
            cached
              .economics
              .landfill_diversion_pct
              .value;

          if (
            diversion ==
            null
          ) {
            return;
          }

          const pct =
            Math.max(
              0,
              Math.min(
                100,
                diversion
              )
            );

          if (fill) {
            fill.style.height =
              pct + "%";
          }

          if (value) {
            value.textContent =
              Math.round(
                pct
              ) + "%";

            value.style.bottom =
              `calc(${pct}% - 2px)`;
          }
        }
      );

    setText(
      "heroChartScenario",
      SCENARIO_LABELS[
        selectedScenario
      ] ||
        selectedScenario
    );

    const selected =
      heroCache[
        selectedScenario
      ];

    if (
      selected?.economics
    ) {
      const diversion =
        selected
          .economics
          .landfill_diversion_pct
          .value;

      setText(
        "heroDiversion",
        diversion ==
          null
          ? "—"
          : diversion.toFixed(
              1
            ) + "%"
      );

      const {
        decision,
      } =
        pickHeadline(
          selected.decisions
        );

      setText(
        "heroDecision",
        decision
          ? titleCaseDecision(
              decision
            ).toUpperCase()
          : "—"
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  function renderMain(
    result,
    scenarioId
  ) {
    lastResult =
      result;

    lastScenarioId =
      scenarioId;

    const r =
      result.optimizer_result;

    const econ =
      result.economics;

    const om =
      result.output_matching;

    const decisions =
      result.decisions ||
      {};

    const mode =
      String(
        result.capacity_mode ||
          ""
      ).toLowerCase();

    const mInfo =
      modeInfo(mode);

    setStatus(
      "DEMO · FY2025–26 Delhi baseline",
      true
    );

    if (
      r.status !==
      "Optimal"
    ) {
      setText(
        "decisionTitle",
        "Scenario infeasible"
      );

      setText(
        "decisionText",
        r.message ||
          "The solver could not find a feasible allocation."
      );

      [
        "throughput",
        "landfill",
        "diversion",
        "power",
      ].forEach(
        (id) =>
          setText(
            id,
            "—"
          )
      );

      renderCompactDecisionChain(
        result
      );

      renderCapacityPanel(
        result
      );

      renderWhyPanel(
        result
      );

      renderMatchingPanel(
        result
      );

      renderPulse();

      return;
    }

    // ---------------------------------------------------------
    // KPI values
    // ---------------------------------------------------------

    const allocatedTotal =
      Object.values(
        r.tonnes_allocated_tpd ||
          {}
      ).reduce(
        (a, b) =>
          a +
          Number(
            b || 0
          ),
        0
      );

    const totalGenerated =
      allocatedTotal +
      Number(
        r.total_landfilled_tpd ||
          0
      );

    setText(
      "throughput",
      fmt(
        totalGenerated
      )
    );

    const throughputNote =
      document.querySelector(
        "#throughputCard .note"
      );

    if (throughputNote) {
      throughputNote.textContent =
        mode ===
        "incremental_spare"
          ? "TPD · additional waste"
          : "TPD · whole network";
    }

    const diversion =
      econ
        ?.landfill_diversion_pct
        ?.value ??
      null;

    const pressure =
      diversion ==
      null
        ? null
        : 100 -
          diversion;

    const landfillCard =
      document.getElementById(
        "landfillCard"
      );

    const diversionCard =
      document.getElementById(
        "diversionCard"
      );

    landfillCard?.classList.remove(
      "warn",
      "alert",
      "critical"
    );

    diversionCard?.classList.remove(
      "warn",
      "alert"
    );

    if (
      pressure !=
      null
    ) {
      if (
        pressure >=
        65
      ) {
        landfillCard?.classList.add(
          "critical"
        );
      } else if (
        pressure >=
        55
      ) {
        landfillCard?.classList.add(
          "alert"
        );
      } else if (
        pressure >=
        45
      ) {
        landfillCard?.classList.add(
          "warn"
        );
      }
    }

    if (
      diversion !=
      null
    ) {
      if (
        diversion <
        50
      ) {
        diversionCard?.classList.add(
          "alert"
        );
      } else if (
        diversion <
        60
      ) {
        diversionCard?.classList.add(
          "warn"
        );
      }
    }

    setText(
      "landfill",
      fmt(
        r.total_landfilled_tpd ||
          0
      )
    );

    setText(
      "landfillPressure",
      pressure ==
        null
        ? "—"
        : pressure.toFixed(
            1
          ) + "%"
    );

    setText(
      "landfillState",
      pressure ==
        null
        ? "N/A"
        : "PRESSURE " +
          pressure.toFixed(
            1
          ) +
          "%"
    );

    const pressureFill =
      document.getElementById(
        "pressureFill"
      );

    if (pressureFill) {
      pressureFill.style.width =
        Math.min(
          100,
          pressure ||
            0
        ) +
        "%";
    }

    setText(
      "diversion",
      diversion ==
        null
        ? "—"
        : diversion.toFixed(
            1
          ) + "%"
    );

    setText(
      "diversionState",
      diversion ==
        null
        ? "N/A"
        : diversion >=
          80
        ? "VERY HIGH"
        : diversion >=
          60
        ? "HEALTHY"
        : diversion >=
          50
        ? "WATCH"
        : "LOW"
    );

    const ring =
      document.getElementById(
        "diversionRing"
      );

    if (ring) {
      const pct =
        diversion ==
        null
          ? 0
          : diversion;

      ring.style.background =
        `conic-gradient(
          var(--teal)
          0 ${pct}%,
          #e6eee9
          ${pct}% 100%
        )`;

      const label =
        ring.querySelector(
          "span"
        );

      if (label) {
        label.textContent =
          diversion ==
          null
            ? "—"
            : Math.round(
                pct
              ) +
              "%";
      }
    }

    const power =
      om
        ?.by_output_type
        ?.power_mwh;

    const powerMatched =
      power
        ?.total_matched_per_day ??
      null;

    const powerUtil =
      power
        ?.utilization_of_recovered_output_pct ??
      null;

    setText(
      "power",
      powerMatched ==
        null
        ? "—"
        : fmt(
            powerMatched
          )
    );

    setText(
      "powerState",
      powerUtil ==
        null
        ? "N/A"
        : powerUtil <
          90
        ? "PARTIAL MATCH"
        : "MATCHED"
    );

    const powerFill =
      document.getElementById(
        "powerFill"
      );

    if (powerFill) {
      powerFill.style.setProperty(
        "--power-width",
        (powerUtil ||
          0) +
          "%"
      );
    }

    // ---------------------------------------------------------
    // Headline decision
    // ---------------------------------------------------------

    const {
      fid,
      decision,
      allStable,
    } =
      pickHeadline(
        decisions
      );

    setText(
      "scopeTag",
      mInfo.label.toUpperCase()
    );

    const scopeTag =
      document.getElementById(
        "scopeTag"
      );

    if (scopeTag) {
      scopeTag.title =
        `${mode} — ${mInfo.sub}`;
    }

    setText(
      "moveIcon",
      decision &&
        DECISION_ICON[
          decision
        ]
        ? DECISION_ICON[
            decision
          ]
        : "●"
    );

    if (!fid) {
      setText(
        "decisionTitle",
        "No facilities in this run"
      );

      setText(
        "decisionText",
        "This scenario produced no facility decisions."
      );
    } else if (
      allStable
    ) {
      setText(
        "decisionTitle",
        "Network stable"
      );

      setText(
        "decisionText",
        "The optimized allocation stays at baseline."
      );
    } else {
      setText(
        "decisionTitle",
        `${titleCaseDecision(
          decision
        )} · ${displayName(
          fid
        )}`
      );

      const info =
        result
          .explanation
          ?.facility_decisions
          ?.[fid];

      const reason =
        info?.reasons?.[
          info.reasons.length -
            1
        ];

      setText(
        "decisionText",
        reason
          ? humanizeReason(
              reason
            ).text
          : "Decision explanation unavailable."
      );
    }

    const reasonLine =
      document.getElementById(
        "reasonLine"
      );

    if (reasonLine) {
      const info =
        fid &&
        result
          .explanation
          ?.facility_decisions
          ?.[fid];

      const reasons =
        info?.reasons ||
        [];

      const chips =
        [];

      reasons
        .slice(
          1,
          3
        )
        .forEach(
          (raw) =>
            chips.push(
              humanizeReason(
                raw
              ).title
            )
        );

      chips.push(
        mInfo.label
      );

      reasonLine.innerHTML =
        chips
          .map(
            (c) =>
              `<span class="reason">${esc(
                c
              )}</span>`
          )
          .join("");
    }

    const occurring =
      new Set(
        Object.values(
          decisions
        )
      );

    const tileIds = {
      BUILD:
        "buildOption",

      RETROFIT:
        "retrofitOption",

      REROUTE:
        "rerouteOption",

      DO_NOTHING:
        "nothingOption",
    };

    Object.entries(
      tileIds
    ).forEach(
      ([type, id]) => {
        const node =
          document.getElementById(
            id
          );

        if (!node) {
          return;
        }

        node.classList.toggle(
          "active",
          occurring.has(
            type
          )
        );

        const span =
          node.querySelector(
            "span"
          );

        const b =
          node.querySelector(
            "b"
          );

        if (span) {
          span.textContent =
            DECISIONS[
              type
            ].label.toUpperCase();
        }

        if (b) {
          b.textContent =
            DECISIONS[
              type
            ].sub.toLowerCase();
        }
      }
    );

    // ---------------------------------------------------------
    // Lower analytics
    // ---------------------------------------------------------

    setText(
      "divertedBar",
      diversion ==
        null
        ? "—"
        : diversion.toFixed(
            1
          ) +
          "%"
    );

    const divertedFill =
      document.getElementById(
        "divertedFill"
      );

    const landfillFill =
      document.getElementById(
        "landfillFill"
      );

    if (divertedFill) {
      divertedFill.style.width =
        (diversion ||
          0) +
        "%";
    }

    if (landfillFill) {
      landfillFill.style.width =
        (pressure ||
          0) +
        "%";
    }

    const avoided =
      econ
        ?.lifecycle_impact_tco2e_per_year
        ?.avoided_emissions
        ?.value;

    setText(
      "emissions",
      avoided ==
        null
        ? "—"
        : formatCompact(
            avoided
          )
    );

    if (econ) {
      setText(
        "impactNote",
        `Modelled against an all-landfilled baseline · financial cost ₹${formatCompact(
          econ
            .financial_cost_rs_per_year
            ?.value
        )}/yr.`
      );
    }

    renderHeroStrip(
      scenarioId
    );

    renderCompactDecisionChain(
      result
    );

    renderCapacityPanel(
      result
    );

    renderWhyPanel(
      result
    );

    renderMatchingPanel(
      result
    );

    renderPulse();
  }

  // ---------------------------------------------------------------------------
  // Decision chain
  // ---------------------------------------------------------------------------

  function renderCompactDecisionChain(
    result
  ) {
    const r =
      result.optimizer_result ||
      {};

    const mode =
      result.capacity_mode ||
      "";

    const {
      fid,
      decision,
      allStable,
    } =
      pickHeadline(
        result.decisions ||
          {}
      );

    const spare =
      Object.values(
        r.base_capacity_tpd ||
          {}
      ).reduce(
        (a, b) =>
          a +
          Number(
            b ||
              0
          ),
        0
      );

    const output =
      result
        .output_matching
        ?.by_output_type
        ?.power_mwh
        ?.total_matched_per_day;

    const recipe =
      lastRecipe?.result;

    const top =
      recipe
        ?.ranked_by_compatibility
        ?.[0];

    const topMethod =
      top
        ? METHOD_LABELS[
            top
          ] ||
          prettyId(
            top
          )
        : "Run Recipe Lab";

    setText(
      "cfChainRecipe",
      topMethod
    );

    setText(
      "cfChainRecipeText",
      top
        ? `${Math.round(
            recipe.methods[
              top
            ]
              .compatibility_score
          )} / 100 fit`
        : "Feedstock fit"
    );

    setText(
      "cfChainCapacity",
      spare
        ? `${fmt(
            spare,
            0
          )} TPD`
        : "—"
    );

    setText(
      "cfChainCapacityText",
      mode ===
        "incremental_spare"
        ? "spare room"
        : "installed capacity"
    );

    setText(
      "cfChainDecision",
      allStable
        ? "Hold"
        : titleCaseDecision(
            decision
          )
    );

    setText(
      "cfChainDecisionText",
      fid
        ? displayName(
            fid
          )
        : "network action"
    );

    setText(
      "cfChainOutput",
      output ==
        null
        ? "—"
        : `${fmt(
            output,
            0
          )} MWh/d`
    );

    setText(
      "cfChainOutputText",
      "matched recovery"
    );
  }

  // ---------------------------------------------------------------------------
  // Capacity panel
  // ---------------------------------------------------------------------------

  function renderCapacityPanel(
    result
  ) {
    const host =
      document.getElementById(
        "cfCapacityPanel"
      );

    if (!host) {
      return;
    }

    const r =
      result.optimizer_result ||
      {};

    const mode =
      result.capacity_mode ||
      "total_network";

    const incremental =
      mode ===
      "incremental_spare";

    const base =
      r.base_capacity_tpd ||
      {};

    const alloc =
      r.tonnes_allocated_tpd ||
      {};

    const binding =
      new Set(
        r.capacity_binding ||
          []
      );

    const rows =
      (
        network?.facilities ||
        []
      )
        .filter(
          (f) =>
            base[
              f.id
            ] !==
            undefined
        )
        .map(
          (f) => {
            const nameplate =
              Number(
                f
                  .capacity_tpd
                  ?.value ||
                  0
              );

            const available =
              Number(
                base[
                  f.id
                ] ||
                  0
              );

            const allocated =
              Number(
                alloc[
                  f.id
                ] ||
                  0
              );

            const remaining =
              Math.max(
                0,
                available -
                  allocated
              );

            const load =
              incremental
                ? Math.max(
                    0,
                    nameplate -
                      available
                  )
                : 0;

            return {
              f,
              nameplate,
              available,
              allocated,
              remaining,
              load,
              binding:
                binding.has(
                  f.id
                ),
            };
          }
        );

    if (!rows.length) {
      host.innerHTML = `
        <div class="cf-panel-head">

          <div>
            <h4>
              Spare capacity / allocation
            </h4>

            <p>
              No facility capacity data was returned for this run.
            </p>
          </div>

        </div>
      `;

      return;
    }

    const totalNameplate =
      rows.reduce(
        (a, x) =>
          a +
          x.nameplate,
        0
      );

    const totalAvailable =
      rows.reduce(
        (a, x) =>
          a +
          x.available,
        0
      );

    const totalAllocated =
      rows.reduce(
        (a, x) =>
          a +
          x.allocated,
        0
      );

    const totalRemaining =
      rows.reduce(
        (a, x) =>
          a +
          x.remaining,
        0
      );

    const totalLoad =
      rows.reduce(
        (a, x) =>
          a +
          x.load,
        0
      );

    const usedPct =
      totalNameplate >
      0
        ? Math.min(
            100,
            (totalAllocated /
              totalNameplate) *
              100
          )
        : 0;

    const loadPct =
      incremental &&
      totalNameplate >
        0
        ? Math.min(
            100 -
              usedPct,
            (totalLoad /
              totalNameplate) *
              100
          )
        : 0;

    const freePct =
      Math.max(
        0,
        100 -
          usedPct -
          loadPct
      );

    host.innerHTML = `
      <div class="cf-panel-head">

        <div>
          <h4>
            Spare capacity / allocation
          </h4>

          <p>
            ${esc(
              modeInfo(
                mode
              ).sub
            )}
          </p>
        </div>

        <span class="cf-pill">
          ${esc(
            modeInfo(
              mode
            ).label
          )}
        </span>

      </div>

      <div class="cf-cap-summary">

        <div class="cf-cap-stat accent">

          <span>
            ${
              incremental
                ? "Modeled spare"
                : "Network capacity"
            }
          </span>

          <b>
            ${fmt(
              totalAvailable,
              0
            )}
          </b>

          <small>
            TPD on the optimizer basis
          </small>

        </div>

        <div class="cf-cap-stat">

          <span>
            Allocated
          </span>

          <b>
            ${fmt(
              totalAllocated,
              0
            )}
          </b>

          <small>
            TPD this run
          </small>

        </div>

        <div class="cf-cap-stat">

          <span>
            Remaining
          </span>

          <b>
            ${fmt(
              totalRemaining,
              0
            )}
          </b>

          <small>
            ${binding.size}
            binding
          </small>

        </div>

      </div>

      <div
        class="cf-cap-total-bar"
        aria-label="Network capacity allocation"
      >

        ${
          incremental &&
          loadPct
            ? `<i
                class="load"
                style="width:${loadPct}%"
              ></i>`
            : ""
        }

        <i
          class="used"
          style="width:${usedPct}%"
        ></i>

        <i
          class="free"
          style="width:${freePct}%"
        ></i>

      </div>

      ${rows
        .map(
          (x) => {
            const denominator =
              Math.max(
                1,
                x.nameplate
              );

            const loadWidth =
              incremental
                ? Math.min(
                    100,
                    (x.load /
                      denominator) *
                      100
                  )
                : 0;

            const allocWidth =
              Math.min(
                100 -
                  loadWidth,
                (x.allocated /
                  denominator) *
                  100
              );

            const freeWidth =
              Math.max(
                0,
                100 -
                  loadWidth -
                  allocWidth
              );

            return `
              <div class="cf-cap-row">

                <div class="cf-cap-row-top">

                  <b>
                    ${esc(
                      displayName(
                        x.f.id
                      )
                    )}
                  </b>

                  <small>
                    ${fmt(
                      x.allocated,
                      0
                    )}
                    /
                    ${fmt(
                      x.available,
                      0
                    )}
                    TPD
                  </small>

                </div>

                <div class="cf-cap-bar">

                  ${
                    incremental &&
                    loadWidth
                      ? `<i
                          class="load"
                          style="width:${loadWidth}%"
                        ></i>`
                      : ""
                  }

                  <i
                    class="used"
                    style="width:${allocWidth}%"
                  ></i>

                  <i
                    class="free"
                    style="width:${freeWidth}%"
                  ></i>

                </div>

                <div class="cf-cap-row-top">

                  <small>
                    ${
                      incremental
                        ? `spare ${fmt(
                            x.available,
                            0
                          )} TPD`
                        : `nameplate ${fmt(
                            x.nameplate,
                            0
                          )} TPD`
                    }
                  </small>

                  <small>
                    ${
                      x.binding
                        ? "CAPACITY BOUND"
                        : `remaining ${fmt(
                            x.remaining,
                            0
                          )} TPD`
                    }
                  </small>

                </div>

              </div>
            `;
          }
        )
        .join("")}

      <div class="cf-cap-foot">

        ${
          incremental
            ? "Incremental-spare mode uses the backend's spare-capacity basis; current load is not independently re-serialized in the frontend."
            : "Total-network mode uses installed/nameplate capacity. It does not claim current physical utilization unless that load is present in the backend data."
        }

      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Why this move
  // ---------------------------------------------------------------------------

  function renderWhyPanel(
    result
  ) {
    const host =
      document.getElementById(
        "cfWhyPanel"
      );

    if (!host) {
      return;
    }

    const {
      fid,
      decision,
      allStable,
    } =
      pickHeadline(
        result.decisions ||
          {}
      );

    const mode =
      result.capacity_mode ||
      "total_network";

    const facility =
      fid
        ? displayName(
            fid
          )
        : "Network";

    const info =
      fid
        ? result
            .explanation
            ?.facility_decisions
            ?.[fid]
        : null;

    const reasons =
      info?.reasons ||
      [];

    const reasonCodes =
      reasons.map(
        (raw) =>
          String(
            raw
          ).split(
            ":"
          )[0]
      );

    const binding =
      new Set(
        result.optimizer_result
          ?.capacity_binding ||
          []
      );

    const isBinding =
      fid
        ? binding.has(
            fid
          )
        : false;

    const scenarioLabel =
      SCENARIO_LABELS[
        result.scenario
      ] ||
      prettyId(
        result.scenario
      );

    const action =
      allStable
        ? "Hold"
        : titleCaseDecision(
            decision
          );

    const actionReason =
      reasons[0]
        ? humanizeReason(
            reasons[0]
          )
        : null;

    let constraintTitle =
      isBinding
        ? "At capacity"
        : "Feasible room";

    let constraintText =
      isBinding
        ? "This facility is at its modelled capacity."
        : "The current run leaves modelled room at this facility.";

    const constraintReason =
      reasons.find(
        (raw) =>
          /CAPACITY_BINDING|CAPACITY/i.test(
            String(raw)
          )
      );

    if (
      constraintReason
    ) {
      const parsed =
        humanizeReason(
          constraintReason
        );

      constraintTitle =
        parsed.title ||
        constraintTitle;

      constraintText =
        parsed.text ||
        constraintText;
    }

    const actionText =
      allStable
        ? "Keep the current allocation; the solver found no need to change it."
        : actionReason?.text ||
          "The solver selected this facility-level action for the current scenario.";

    const extraCodes =
      reasonCodes
        .filter(
          (code) =>
            ![
              "NO_CHANGE_FROM_BASELINE_ALLOCATION",
              "CAPACITY_BINDING",
              "CAPACITY_BINDING_AT_DESTINATION",
            ].includes(
              code
            )
        )
        .slice(
          0,
          2
        );

    const extra =
      extraCodes.length
        ? extraCodes
            .map(
              (code) =>
                REASONS[
                  code
                ]?.[0] ||
                prettyId(
                  code
                )
            )
            .join(
              " · "
            )
        : "No additional facility-level explanation was returned.";

    host.innerHTML = `
      <div class="cf-panel-head">

        <div>

          <h4>
            Why this move?
          </h4>

          <p>
            The optimizer's decision, the active constraint and the scenario context — shown once, in order.
          </p>

        </div>

        <span class="cf-pill">
          live explanation
        </span>

      </div>

      <div class="cf-why-top">

        <div class="cf-why-icon">
          ${esc(
            DECISION_ICON[
              decision
            ] ||
              "●"
          )}
        </div>

        <div class="cf-why-title">

          <b>
            ${esc(
              action
            )}
            ·
            ${esc(
              facility
            )}
          </b>

          <span>
            ${
              fid
                ? "Facility-level trace from the current optimizer run."
                : "Network-level trace; no facility was singled out."
            }
          </span>

        </div>

        <span class="cf-why-chip">
          ${esc(
            result.mode ||
              "demo"
          )}
          mode
        </span>

      </div>

      <div class="cf-why-meta">

        <span class="cf-why-chip">
          ${esc(
            scenarioLabel
          )}
        </span>

        <span class="cf-why-chip">
          ${esc(
            modeInfo(
              mode
            ).label
          )}
        </span>

        <span class="cf-why-chip">
          ${
            isBinding
              ? "capacity bound"
              : "capacity not binding"
          }
        </span>

      </div>

      <div class="cf-why-trace">

        <div class="cf-trace-card">

          <div class="cf-trace-no">
            01 · action
          </div>

          <b>
            ${esc(
              action
            )}
          </b>

          <span>
            ${esc(
              actionText
            )}
          </span>

        </div>

        <div class="cf-trace-card">

          <div class="cf-trace-no">
            02 · constraint
          </div>

          <b>
            ${esc(
              constraintTitle
            )}
          </b>

          <span>
            ${esc(
              constraintText
            )}
          </span>

        </div>

        <div class="cf-trace-card">

          <div class="cf-trace-no">
            03 · context
          </div>

          <b>
            ${esc(
              scenarioLabel
            )}
          </b>

          <span>
            ${esc(
              modeInfo(
                mode
              ).sub
            )}
          </span>

        </div>

      </div>

      <div class="cf-why-foot">

        <b>
          Additional evidence
        </b>

        ·

        ${esc(
          extra
        )}

      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Output matching
  // ---------------------------------------------------------------------------

  function outputNodeId(
    value,
    fallback = ""
  ) {
    if (
      value ==
      null
    ) {
      return fallback;
    }

    if (
      typeof value ===
        "string" ||
      typeof value ===
        "number"
    ) {
      return String(
        value
      );
    }

    if (
      typeof value ===
      "object"
    ) {
      return (
        value.source_id ||
        value.sourceId ||
        value.demand_id ||
        value.demandId ||
        value.node_id ||
        value.id ||
        fallback
      );
    }

    return fallback;
  }

  function renderMatchingPanel(
    result
  ) {
    const host =
      document.getElementById(
        "cfMatchingPanel"
      );

    if (!host) {
      return;
    }

    const om =
      result
        .output_matching
        ?.by_output_type;

    const r =
      result.optimizer_result ||
      {};

    if (!om) {
      host.innerHTML = `
        <div class="cf-panel-head">

          <div>

            <h4>
              Output-first matching
            </h4>

            <p>
              No output matching was returned for this run.
            </p>

          </div>

        </div>
      `;

      return;
    }

    const blocks =
      Object.entries(
        om
      )
        .map(
          ([
            type,
            d,
          ]) => {
            const lab =
              OUTPUT_LABELS[
                type
              ] || {
                name:
                  prettyId(
                    type
                  ),
                unit:
                  "per day",
              };

            const matches =
              d.matches ||
              [];

            const utilization =
              Number(
                d
                  .utilization_of_recovered_output_pct ||
                  0
              );

            const fulfilment =
              Number(
                d
                  .demand_fulfilment_pct ||
                  0
              );

            const supply =
              Number(
                d.total_supply_per_day ||
                  0
              );

            const demand =
              Number(
                d.total_demand_per_day ||
                  0
              );

            const matched =
              Number(
                d.total_matched_per_day ||
                  0
              );

            const unmet =
              Object.values(
                d.unmet_by_demand ||
                  {}
              ).reduce(
                (a, b) =>
                  a +
                  Number(
                    b ||
                      0
                  ),
                0
              );

            const unused =
              Object.values(
                d.unused_by_source ||
                  {}
              ).reduce(
                (a, b) =>
                  a +
                  Number(
                    b ||
                      0
                  ),
                0
              );

            const ledger =
              matches
                .map(
                  (m) => {
                    const sourceId =
                      outputNodeId(
                        m.source,
                        m.source_id ||
                          m.sourceId ||
                          "Recovery source"
                      );

                    const demandId =
                      outputNodeId(
                        m.demand_node,
                        m.demand_id ||
                          m.demandId ||
                          "Demand node"
                      );

                    const qty =
                      Number(
                        m.matched_quantity_per_day ||
                          0
                      );

                    return `
                      <div class="cf-match-row">

                        <div class="cf-match-node">

                          <b>
                            ${esc(
                              displayName(
                                sourceId
                              ) ||
                                sourceId
                            )}
                          </b>

                          <small>
                            recovered source
                          </small>

                        </div>

                        <div class="cf-match-arrow">
                          →
                        </div>

                        <div class="cf-match-node">

                          <b>
                            ${esc(
                              prettyId(
                                demandId
                              )
                            )}
                          </b>

                          <small>
                            modeled offtaker
                          </small>

                        </div>

                        <div class="cf-match-qty">

                          <b>
                            ${fmt(
                              qty
                            )}
                          </b>

                          <small>
                            ${lab.unit}
                          </small>

                        </div>

                      </div>
                    `;
                  }
                )
                .join("");

            const remains =
              [];

            if (
              unused >
              0
            ) {
              remains.push(
                `<span class="cf-remain">
                  unused recovered
                  <b>
                    ${fmt(
                      unused
                    )}
                    ${lab.unit}
                  </b>
                </span>`
              );
            }

            if (
              unmet >
              0
            ) {
              remains.push(
                `<span class="cf-remain">
                  unmet demand
                  <b>
                    ${fmt(
                      unmet
                    )}
                    ${lab.unit}
                  </b>
                </span>`
              );
            }

            if (
              !remains.length
            ) {
              remains.push(
                `<span class="cf-remain">
                  all supplied output finds a modeled destination
                </span>`
              );
            }

            return `
              <div class="cf-output-block">

                <div class="cf-output-block-head">

                  <b>
                    ${esc(
                      lab.name
                    )}
                  </b>

                  <span>
                    ${
                      d.stream_scope?.includes(
                        "AUXILIARY"
                      )
                        ? "Auxiliary stream"
                        : "Main network"
                    }
                  </span>

                </div>

                <div class="cf-output-summary">

                  <div class="cf-output-stat main">

                    <span>
                      matched output
                    </span>

                    <b>
                      ${fmt(
                        matched
                      )}
                    </b>

                    <small>
                      ${lab.unit}
                    </small>

                  </div>

                  <div class="cf-output-stat">

                    <span>
                      recovered supply
                    </span>

                    <b>
                      ${fmt(
                        supply
                      )}
                    </b>

                    <small>
                      ${lab.unit}
                    </small>

                  </div>

                  <div class="cf-output-stat">

                    <span>
                      modeled demand
                    </span>

                    <b>
                      ${fmt(
                        demand,
                        0
                      )}
                    </b>

                    <small>
                      ${lab.unit}
                    </small>

                  </div>

                </div>

                <div class="cf-output-meters">

                  <div class="cf-output-meter">

                    <div class="cf-output-meter-head">

                      <span>
                        Recovered output used
                      </span>

                      <b>
                        ${utilization.toFixed(
                          1
                        )}%
                      </b>

                    </div>

                    <div class="cf-output-track">

                      <i
                        style="width:${Math.min(
                          100,
                          Math.max(
                            0,
                            utilization
                          )
                        )}%"
                      ></i>

                    </div>

                  </div>

                  <div class="cf-output-meter">

                    <div class="cf-output-meter-head">

                      <span>
                        Demand fulfilled
                      </span>

                      <b>
                        ${fulfilment.toFixed(
                          1
                        )}%
                      </b>

                    </div>

                    <div class="cf-output-track">

                      <i
                        class="alt"
                        style="width:${Math.min(
                          100,
                          Math.max(
                            0,
                            fulfilment
                          )
                        )}%"
                      ></i>

                    </div>

                  </div>

                </div>

                <div class="cf-match-ledger">

                  ${
                    ledger ||
                    `
                      <div class="cf-match-note">
                        No positive source → demand match was returned for this output type.
                      </div>
                    `
                  }

                </div>

                <div class="cf-remains">
                  ${remains.join(
                    ""
                  )}
                </div>

              </div>
            `;
          }
        )
        .join("");

    host.innerHTML = `
      <div class="cf-panel-head">

        <div>

          <h4>
            Output-first matching
          </h4>

          <p>
            Recovery only becomes useful when the output can actually find a modeled destination.
          </p>

        </div>

        <span class="cf-pill">
          LP match result
        </span>

      </div>

      ${blocks}

      <div class="cf-match-note">

        ${
          r.status ===
          "Optimal"
            ? "Output yields, operating rates and demand are DEMO-mode assumptions; the source → demand matches themselves are taken from the backend output-matching result."
            : "Output matching is unavailable because the optimizer did not return an optimal scenario."
        }

      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Recipe engine
  // ---------------------------------------------------------------------------

  function renderRecipe(
    result,
    label
  ) {
    lastRecipe = {
      label,
      result,
    };

    const top =
      result
        .ranked_by_compatibility
        ?.[0];

    const methods =
      result.methods ||
      {};

    const topMethod =
      top
        ? methods[
            top
          ]
        : null;

    const fs =
      result.feedstock_submitted ||
      result.feedstock ||
      {};

    if (!topMethod) {
      setText(
        "recipeState",
        "Insufficient data"
      );

      setText(
        "recipeConfidence",
        "no pathway scored"
      );

      return;
    }

    const score =
      Number(
        topMethod.compatibility_score ??
          0
      );

    const verdict =
      topMethod.category ===
      "Compatible"
        ? "Strong fit"
        : topMethod.category ===
          "Marginal"
        ? "Partial fit"
        : "Poor fit";

    setText(
      "score",
      Math.round(
        score
      )
    );

    const scoreRing =
      document.getElementById(
        "scoreRing"
      );

    if (scoreRing) {
      scoreRing.style.background =
        `conic-gradient(
          var(--teal)
          0 ${score}%,
          #e0eae5
          ${score}% 100%
        )`;
    }

    setText(
      "recipeInput",
      label
    );

    setText(
      "recipeRoute",
      METHOD_LABELS[
        top
      ] ||
        prettyId(
          top
        )
    );

    setText(
      "recipeOutput",
      topMethod.category ===
        "Incompatible"
        ? "limited value"
        : "recoverable value"
    );

    setText(
      "rfOrganic",
      fs.organic_fraction ==
        null
        ? "—"
        : Math.round(
            Number(
              fs.organic_fraction
            ) *
              100
          ) + "%"
    );

    setText(
      "rfMoisture",
      fs.moisture_pct ==
        null
        ? "—"
        : fmt(
            fs.moisture_pct,
            0
          ) + "%"
    );

    setText(
      "rfContamination",
      fs.contamination_pct ==
        null
        ? "—"
        : fmt(
            fs.contamination_pct,
            0
          ) + "%"
    );

    setText(
      "rfCn",
      fs.cn_ratio ==
        null
        ? "—"
        : fmt(
            fs.cn_ratio,
            0
          ) + ":1"
    );

    setText(
      "recipeState",
      verdict
    );

    setText(
      "recipeConfidence",
      `${String(
        topMethod.confidence ||
          "UNKNOWN"
      )} confidence · ${
        topMethod.factors_evaluated ||
        "factor set returned by backend"
      }`
    );

    const compat =
      document.getElementById(
        "recipeCompat"
      );

    if (compat) {
      compat.innerHTML = `
        <span class="${
          topMethod.category ===
          "Incompatible"
            ? "warn"
            : "good"
        }">
          ${esc(
            topMethod.category ||
              "Unknown"
          )}
        </span>

        <span class="good">
          ${esc(
            topMethod.confidence ||
              "Unknown"
          )}
          confidence
        </span>

        <span class="${
          topMethod
            .limiting_factors
            ?.length
            ? "warn"
            : "good"
        }">
          ${
            topMethod
              .limiting_factors
              ?.length
              ? "watch factors returned"
              : "✓ no limiting factors"
          }
        </span>

        <span class="good">
          advisory only
        </span>
      `;
    }

    const compare =
      document.getElementById(
        "recipeCompare"
      );

    if (compare) {
      compare.innerHTML =
        Object.entries(
          methods
        )
          .sort(
            (a, b) =>
              Number(
                b[1]
                  .compatibility_score ??
                  -1
              ) -
              Number(
                a[1]
                  .compatibility_score ??
                  -1
              )
          )
          .map(
            ([
              key,
              method,
            ]) => {
              const value =
                Number(
                  method.compatibility_score ??
                    0
                );

              const active =
                key ===
                top
                  ? " active"
                  : "";

              return `
                <div class="cf-tech-row${active}">

                  <b>
                    ${esc(
                      METHOD_LABELS[
                        key
                      ] ||
                        prettyId(
                          key
                        )
                    )}
                  </b>

                  <div class="cf-tech-track">

                    <i
                      style="width:${Math.max(
                        0,
                        Math.min(
                          100,
                          value
                        )
                      )}%"
                    ></i>

                  </div>

                  <span class="cf-tech-score">
                    ${Math.round(
                      value
                    )}
                  </span>

                </div>
              `;
            }
          )
          .join("");
    }

    const inputs =
      document.getElementById(
        "recipeInputs"
      );

    if (inputs) {
      inputs.innerHTML =
        Object.entries(
          fs
        )
          .filter(
            ([key]) =>
              FEEDSTOCK_LABELS[
                key
              ]
          )
          .map(
            ([
              key,
              value,
            ]) =>
              `<span class="cf-recipe-input">
                ${esc(
                  FEEDSTOCK_LABELS[
                    key
                  ][0]
                )}
                <b>
                  ${esc(
                    FEEDSTOCK_LABELS[
                      key
                    ][1](
                      value
                    )
                  )}
                </b>
              </span>`
          )
          .join("");
    }

    setText(
      "recipeMeterValue",
      Math.round(
        score
      ) +
        "%"
    );

    const meter =
      document.getElementById(
        "recipeMeter"
      );

    if (meter) {
      meter.style.width =
        Math.max(
          0,
          Math.min(
            100,
            score
          )
        ) +
        "%";
    }

    // Prevent the old limiting-factor explanation
    // from appearing anywhere else.
    document
      .querySelectorAll(
        "#limitingTitle,#limitingText,.recipe-insight,.recipe-explanation,.limiting-factor"
      )
      .forEach(
        (node) => {
          node.style.display =
            "none";
        }
      );

    if (lastResult) {
      renderCompactDecisionChain(
        lastResult
      );
    }
  }

  window.runRecipePreset =
    async function runRecipePreset(
      key
    ) {
      const preset =
        RECIPE_PRESETS[
          key
        ] ||
        RECIPE_PRESETS.mixed;

      const {
        label,
        ...feedstock
      } = preset;

      try {
        const result =
          await CrossFlowAPI.recipe(
            feedstock
          );

        renderRecipe(
          result,
          label
        );
      } catch (err) {
        console.error(
          "recipe fetch failed",
          err
        );

        setText(
          "recipeState",
          "Unavailable"
        );

        setText(
          "recipeConfidence",
          "API connection required"
        );
      }
    };

  // ---------------------------------------------------------------------------
  // Network pulse
  // ---------------------------------------------------------------------------

  function renderPulse() {
    const panel =
      document.getElementById(
        "cfPulsePanel"
      );

    if (!panel) {
      return;
    }

    const rows =
      Object.keys(
        SCENARIO_LABELS
      ).map(
        (sid) => ({
          sid,
          label:
            SCENARIO_LABELS[
              sid
            ],

          value:
            heroCache[sid]
              ?.economics
              ?.landfill_diversion_pct
              ?.value ==
            null
              ? null
              : Number(
                  heroCache[sid]
                    .economics
                    .landfill_diversion_pct
                    .value
                ),
        })
      );

    const usable =
      rows.filter(
        (x) =>
          x.value !=
          null
      );

    if (!usable.length) {
      return;
    }

    const width =
      640;

    const height =
      150;

    const left =
      18;

    const right =
      12;

    const top =
      14;

    const bottom =
      122;

    const step =
      usable.length >
      1
        ? (width -
            left -
            right) /
          (usable.length -
            1)
        : 0;

    const y = (
      value
    ) =>
      bottom -
      (Math.max(
        0,
        Math.min(
          100,
          value
        )
      ) /
        100) *
        (bottom -
          top);

    const points =
      usable.map(
        (
          item,
          index
        ) => [
          left +
            index *
              step,

          y(
            item.value
          ),
        ]
      );

    const path =
      points
        .map(
          (
            [
              x,
              yv,
            ],
            i
          ) =>
            `${
              i
                ? "L"
                : "M"
            }${x.toFixed(
              1
            )} ${yv.toFixed(
              1
            )}`
        )
        .join(
          " "
        );

    const area =
      `${path} L ${
        points.at(-1)[0]
      } ${bottom} L ${
        points[0][0]
      } ${bottom} Z`;

    panel.innerHTML = `
      <div class="panel-head">

        <h3>
          Network pulse
        </h3>

        <span>
          scenario diversion
        </span>

      </div>

      <div class="cf-pulse-stage">

        <svg
          class="cf-pulse-chart"
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          aria-label="Scenario diversion comparison"
        >

          <line
            class="grid"
            x1="${left}"
            y1="${y(100)}"
            x2="${width - right}"
            y2="${y(100)}"
          ></line>

          <line
            class="grid"
            x1="${left}"
            y1="${y(50)}"
            x2="${width - right}"
            y2="${y(50)}"
          ></line>

          <line
            class="grid"
            x1="${left}"
            y1="${y(0)}"
            x2="${width - right}"
            y2="${y(0)}"
          ></line>

          <path
            class="area"
            d="${area}"
          ></path>

          <path
            class="line"
            d="${path}"
          ></path>

          ${points
            .map(
              (
                [
                  x,
                  yv,
                ],
                i
              ) =>
                `
                  <circle
                    class="point${
                      usable[i].sid ===
                      lastScenarioId
                        ? " active"
                        : ""
                    }"
                    cx="${x}"
                    cy="${yv}"
                    r="4.2"
                  ></circle>
                `
            )
            .join("")}

        </svg>

        <div class="cf-pulse-labels">

          ${usable
            .map(
              (
                item
              ) =>
                `
                  <div class="cf-pulse-label">

                    <span>
                      ${esc(
                        item.label
                          .replace(
                            "Ghazipur outage",
                            "Outage"
                          )
                          .replace(
                            "Festival +20%",
                            "Festival"
                          )
                          .replace(
                            "Monsoon +30%",
                            "Monsoon"
                          )
                          .replace(
                            "Spare capacity",
                            "Spare"
                          )
                      )}
                    </span>

                    <b>
                      ${item.value.toFixed(
                        1
                      )}%
                    </b>

                  </div>
                `
            )
            .join("")}

        </div>

        <div class="cf-pulse-note">
          Higher values indicate more landfill diversion under the selected scenario run.
          The highlighted point is the currently selected scenario.
        </div>

      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------

  function updateMapDetail(
    title,
    type,
    detail,
    evidence = ""
  ) {
    const node =
      document.getElementById(
        "cfMapDetail"
      );

    if (!node) {
      return;
    }

    node.innerHTML =
      `<small>${esc(
        type
      )}</small>
       <b>${esc(
         title
       )}</b>
       <span>${esc(
         detail
       )}${
         evidence
           ? ` · ${esc(
               evidence
             )}`
           : ""
       }</span>`;
  }

    function renderMap(net) {
    const el =
      document.getElementById(
        "leafletMap"
      );

    if (!el) {
      return net;
    }

    if (
      typeof L ===
      "undefined"
    ) {
      console.warn(
        "Leaflet is not available."
      );

      return net;
    }

    // Remove any previous CrossFlow map instance.
    if (
      window.__crossFlowMap
    ) {
      window.__crossFlowMap.remove();
      window.__crossFlowMap =
        null;
    }

    // Make the real map visible.
    el.style.display =
      "block";

    // Clear anything left inside the container.
    el.innerHTML = "";

    const map =
      L.map(
        el,
        {
          zoomControl:
            false,
          attributionControl:
            true,
          minZoom: 7,
          maxZoom: 20,
          worldCopyJump:
            false,
        }
      );

    window.__crossFlowMap =
      map;

    mapMarkers = {};

    if (!document.getElementById("cfMapCss")) {
      const mapStyle = document.createElement("style");
      mapStyle.id = "cfMapCss";
      mapStyle.textContent = `
        .cf-map-legend{background:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 4px 18px rgba(16,40,32,.14);font-family:Inter,system-ui,sans-serif;min-width:150px;}
        .cf-map-legend-title{font-size:9px;font-weight:900;letter-spacing:.08em;color:#719086;margin-bottom:7px;}
        .cf-map-legend-row{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;color:#18382e;margin-bottom:5px;}
        .cf-map-dot{width:10px;height:10px;border-radius:50%;display:inline-block;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.12);}
        .cf-source-dot{background:#ff7a00;}
        .cf-facility-dot{background:#2563eb;}
        .cf-map-satellite{margin-top:6px;padding-top:6px;border-top:1px solid #e3ece7;font-size:9px;font-weight:800;letter-spacing:.06em;color:#9bb3ab;}
        .cf-map-detail{margin-top:12px;padding:12px 14px;border-radius:12px;background:#f3f8f5;border:1px solid #e3ece7;font-family:Inter,system-ui,sans-serif;}
        .cf-map-detail small{display:block;font-size:9px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#719086;margin-bottom:3px;}
        .cf-map-detail b{display:block;font-size:14px;font-weight:900;color:#18382e;margin-bottom:3px;}
        .cf-map-detail span{display:block;font-size:11px;color:#527067;}
        .leaflet-container{cursor:grab;}
      `;
      document.head.appendChild(mapStyle);
    }

    const existingDetail =
      document.getElementById("cfMapDetail");

    if (!existingDetail && el.parentElement) {
      el.insertAdjacentHTML(
        "afterend",
        `<div id="cfMapDetail" class="cf-map-detail">
          <small>Tap a marker</small>
          <b>Live facility detail</b>
          <span>Click any source or facility pin to see its current scenario status here.</span>
        </div>`
      );
    }

    // -----------------------------------------------------------------------
    // STREET MAP BASEMAP
    // -----------------------------------------------------------------------

    L.tileLayer(
      "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
      {
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · rendering <a href="https://openstreetmap.fr/">OpenStreetMap France</a>',
      }
    ).addTo(
      map
    );

    // -----------------------------------------------------------------------
    // MAP VIEW
    // -----------------------------------------------------------------------

    const delhiCenter =
      [
        28.6139,
        77.2090,
      ];

    map.setView(
      delhiCenter,
      10.5
    );

    L.control
      .zoom(
        {
          position:
            "bottomright",
        }
      )
      .addTo(
        map
      );

    // -----------------------------------------------------------------------
    // LEGEND
    // -----------------------------------------------------------------------

    const legend =
      L.control(
        {
          position:
            "topright",
        }
      );

    legend.onAdd =
      function () {
        const box =
          L.DomUtil.create(
            "div",
            "leaflet-control cf-map-legend"
          );

        box.innerHTML = `
          <div class="cf-map-legend-title">
            CROSSFLOW NETWORK
          </div>

          <div class="cf-map-legend-row">
            <span class="cf-map-dot cf-source-dot"></span>
            Waste source
          </div>

          <div class="cf-map-legend-row">
            <span class="cf-map-dot cf-facility-dot"></span>
            Processing facility
          </div>

          <div class="cf-map-satellite">
            STREET NETWORK
          </div>
        `;

        L.DomEvent.disableClickPropagation(
          box
        );

        return box;
      };

    legend.addTo(
      map
    );

    // -----------------------------------------------------------------------
    // NODE HELPERS
    // -----------------------------------------------------------------------

    function getNodeName(
      node
    ) {
      return (
        node?.display_name ||
        node?.name ||
        node?.facility_name ||
        node?.source_name ||
        "Unnamed node"
      );
    }

    function getNodeTPD(
      node
    ) {
      const value =
        Number(
          node?.daily_tpd ??
            node?.tpd ??
            node?.capacity_tpd ??
            node?.quantity_tpd ??
            0
        );

      return Number.isFinite(
        value
      )
        ? value
        : 0;
    }

    function addNode(
      node,
      kind
    ) {
      const coordinates =
        node?.coordinates;

      if (
        !coordinates
      ) {
        return null;
      }

      const lat =
        Number(
          coordinates.lat
        );

      const lon =
        Number(
          coordinates.lon ??
            coordinates.lng
        );

      if (
        !Number.isFinite(
          lat
        ) ||
        !Number.isFinite(
          lon
        )
      ) {
        return null;
      }

      const isSource =
        kind ===
        "source";

      const baseRadius =
        isSource
          ? 8
          : 10;

      const marker =
        L.circleMarker(
          [
            lat,
            lon,
          ],
          {
            radius:
              baseRadius,

            color:
              "#ffffff",

            weight:
              3,

            fillColor:
              isSource
                ? "#ff7a00"
                : "#2563eb",

            fillOpacity:
              1,

            opacity:
              1,
          }
        ).addTo(
          map
        );

      marker.bindPopup(
        buildMapPopupHtml(node, kind),
        { maxWidth: 260 }
      );

      // Hover feedback: grow + thicken the ring, revert on mouseout.
      marker.on("mouseover", () => {
        marker.setStyle({ radius: baseRadius + 3, weight: 4 });
      });
      marker.on("mouseout", () => {
        marker.setStyle({ radius: baseRadius, weight: 3 });
      });

      // Click feedback: refresh the popup with the latest scenario data right
      // before it opens (covers the case where a scenario ran since this marker
      // was created), and mirror the same info into the side detail card so the
      // click has a second, more durable place to land than a popup bubble.
      marker.on("click", () => {
        marker.setPopupContent(buildMapPopupHtml(node, kind));
        const name = displayName(node.id) || getNodeName(node);
        const typeLabel = isSource ? "Waste source" : "Processing facility";
        let detail;
        if (isSource) {
          const info = sourceLiveInfo(node.id);
          detail = info
            ? `${fmt(info.routed)} TPD routed${info.landfilled > 0 ? `, ${fmt(info.landfilled)} TPD landfilled` : ", none landfilled"}`
            : `${fmt(getNodeTPD(node))} TPD generation (static network data)`;
        } else {
          const status = facilityLiveStatus(node.id);
          detail = status
            ? `${status.label}${Number.isFinite(status.allocated) ? ` · ${fmt(status.allocated)} TPD allocated` : ""}`
            : `${fmt(getNodeTPD(node))} TPD nameplate (static network data)`;
        }
        const scenarioLabel = lastScenarioId ? (SCENARIO_LABELS[lastScenarioId] || prettyId(lastScenarioId)) : "no scenario run yet";
        updateMapDetail(name, typeLabel, detail, scenarioLabel);
      });

      mapMarkers[node.id] = { marker, node, kind };

      return [
        lat,
        lon,
      ];
    }

    // -----------------------------------------------------------------------
    // ADD LIVE NETWORK NODES
    // -----------------------------------------------------------------------

    const bounds =
      [];

    (
      net?.source_nodes ||
      []
    ).forEach(
      (
        node
      ) => {
        const point =
          addNode(
            node,
            "source"
          );

        if (
          point
        ) {
          bounds.push(
            point
          );
        }
      }
    );

    (
      net?.facilities ||
      []
    ).forEach(
      (
        node
      ) => {
        const point =
          addNode(
            node,
            "facility"
          );

        if (
          point
        ) {
          bounds.push(
            point
          );
        }
      }
    );

    // -----------------------------------------------------------------------
    // FIT MAP TO NETWORK
    // -----------------------------------------------------------------------

    if (
      bounds.length >=
      2
    ) {
      map.fitBounds(
        bounds,
        {
          padding:
            [
              55,
              55,
            ],
          maxZoom:
            11.5,
        }
      );
    }

    // -----------------------------------------------------------------------
    // MAP STATS
    // -----------------------------------------------------------------------

    const stats =
      document.getElementById(
        "mapStats"
      );

    if (
      stats
    ) {
      const sourceCount =
        (
          net?.source_nodes ||
          []
        ).length;

      const facilityCount =
        (
          net?.facilities ||
          []
        ).length;

      const totalTpd =
        (
          net?.source_nodes ||
          []
        ).reduce(
          (
            sum,
            node
          ) =>
            sum +
            getNodeTPD(
              node
            ),
          0
        );

      stats.innerHTML = `
        <span class="map-chip">
          ${sourceCount} waste sources
        </span>

        <span class="map-chip">
          ${facilityCount} facilities
        </span>

        ${
          totalTpd > 0
            ? `
              <span class="map-chip">
                ${formatCompact(totalTpd)} TPD network
              </span>
            `
            : ""
        }

        <span class="map-chip">
          street network
        </span>
      `;
    }

    // -----------------------------------------------------------------------
    // MAP CAPTION
    // -----------------------------------------------------------------------

    const caption =
      document.getElementById(
        "mapCaption"
      );

    if (
      caption
    ) {
      caption.textContent =
        "Street network view · Delhi · live CrossFlow source + facility nodes";
    }

    // -----------------------------------------------------------------------
    // REMOVE OLD DECORATIVE MAP LAYERS
    // -----------------------------------------------------------------------

    const parent =
      el.parentElement;

    if (
      parent
    ) {
      parent
        .querySelectorAll(
          ".map-water,.delhi,.route,.zone,.hub,#cfMapPaused"
        )
        .forEach(
          (
            node
          ) => {
            node.style.display =
              "none";
          }
        );
    }

    // Leaflet sometimes calculates its dimensions before
    // the surrounding section has finished rendering.
    setTimeout(
      () => {
        map.invalidateSize(
          true
        );
      },
      250
    );

    return net;
  }


  // ---------------------------------------------------------------------------
  // Live map status (reads already-returned pipeline fields only -- no new
  // optimizer/economics calculation; this is purely a presentation lookup
  // against lastResult, same pattern as pickHeadline/titleCaseDecision above)
  // ---------------------------------------------------------------------------

  function facilityLiveStatus(fid) {
    if (!lastResult?.optimizer_result) return null;
    const r = lastResult.optimizer_result;
    const allocatedRaw = r.tonnes_allocated_tpd?.[fid];
    const baseRaw = r.base_capacity_tpd?.[fid];
    if (allocatedRaw === undefined && baseRaw === undefined) return null;
    const allocated = allocatedRaw === undefined ? null : Number(allocatedRaw);
    const base = baseRaw === undefined ? null : Number(baseRaw);
    const decision = lastResult.decisions?.[fid] || null;
    const binding = (r.capacity_binding || []).includes(fid);
    if (base === 0 && allocated === 0) {
      return { label: "Offline this scenario", color: "#ef4444", decision, allocated, base, binding };
    }
    if (decision === "BUILD") return { label: "Built this scenario", color: "#16a34a", decision, allocated, base, binding };
    if (decision === "RETROFIT") return { label: "Retrofitted this scenario", color: "#a855f7", decision, allocated, base, binding };
    if (decision === "REROUTE") return { label: "Allocation rerouted", color: "#f59e0b", decision, allocated, base, binding };
    return { label: "Steady state", color: null, decision: decision || "DO_NOTHING", allocated, base, binding };
  }

  function sourceLiveInfo(nid) {
    if (!lastResult?.optimizer_result) return null;
    const r = lastResult.optimizer_result;
    const landfilled = Number(r.landfilled_tpd?.[nid] ?? 0);
    let routed = 0;
    Object.entries(r.flows_tpd || {}).forEach(([key, val]) => {
      if (key.startsWith(nid + "->")) routed += Number(val) || 0;
    });
    return { routed, landfilled };
  }

  function buildMapPopupHtml(node, kind) {
    const isSource = kind === "source";
    const name = displayName(node.id) || node.display_name || node.name || "Unnamed node";
    const typeLabel = isSource ? "Waste source" : "Processing facility";
    let liveBlock = "";

    if (isSource) {
      const info = sourceLiveInfo(node.id);
      if (info) {
        liveBlock = `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e3ece7;font-size:11px;color:#2b4a3f;">
            <div>Routed this scenario: <b>${fmt(info.routed)} TPD</b></div>
            ${info.landfilled > 0
              ? `<div style="color:#b3261e;margin-top:3px;">Landfilled: <b>${fmt(info.landfilled)} TPD</b></div>`
              : `<div style="color:#1f8a5f;margin-top:3px;">Fully routed, no landfill this scenario</div>`}
          </div>`;
      }
    } else {
      const nameplate = Number(node.capacity_tpd?.value || 0);
      const status = facilityLiveStatus(node.id);
      liveBlock = `
        ${nameplate > 0 ? `<div style="margin-top:7px;font-size:11px;color:#527067;">Nameplate ${fmt(nameplate)} TPD</div>` : ""}
        ${status ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #e3ece7;">
            <span style="display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:800;color:#fff;background:${status.color || "#2563eb"};">${esc(status.label)}</span>
            ${Number.isFinite(status.allocated) && Number.isFinite(status.base) && status.base > 0 ? `
              <div style="margin-top:6px;font-size:11px;color:#2b4a3f;">Allocated ${fmt(status.allocated)} / ${fmt(status.base)} TPD</div>
              <div style="margin-top:4px;height:5px;border-radius:3px;background:#e3ece7;overflow:hidden;">
                <div style="height:100%;width:${Math.min(100, status.base > 0 ? (status.allocated / status.base) * 100 : 0)}%;background:${status.color || "#2563eb"};"></div>
              </div>` : ""}
            ${status.binding ? `<div style="margin-top:5px;font-size:10px;color:#b3261e;font-weight:800;">CAPACITY BOUND</div>` : ""}
          </div>` : ""}
      `;
    }

    return `
      <div style="min-width:200px;font-family:Inter,system-ui,sans-serif;padding:2px;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:900;color:#719086;margin-bottom:5px;">${esc(typeLabel)}</div>
        <div style="font-size:15px;font-weight:900;color:#18382e;line-height:1.2;">${esc(name)}</div>
        ${liveBlock}
      </div>`;
  }

  function refreshMapLiveData() {
    if (!window.__crossFlowMap) return;
    Object.values(mapMarkers).forEach(({ marker, node, kind }) => {
      try {
        marker.setPopupContent(buildMapPopupHtml(node, kind));
      } catch (err) {
        // popup may not be open / Leaflet version quirk -- never let map refresh break rendering
      }
      if (kind === "facility") {
        const status = facilityLiveStatus(node.id);
        marker.setStyle({ fillColor: (status && status.color) || "#2563eb" });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Run a scenario against the real API (fixes the "stuck on Loading
  // scenarios…" bug: this function previously did not exist at all, so the
  // single call site below threw a ReferenceError that init() never caught,
  // leaving the status text stuck on whatever it last said and nothing ever
  // rendered. It now exists, is defensive about being called with or without
  // arguments, and every failure path leaves a clear, visible state instead
  // of hanging silently.)
  // ---------------------------------------------------------------------------

  async function runScenario(scenarioId, capacityMode) {
    const scenarioSelect = document.getElementById("scenario");
    const capacitySelect = document.getElementById("capacity");
    const id = scenarioId || scenarioSelect?.value;
    const mode = capacityMode || capacitySelect?.value || scenarioDefaults[id];

    if (!id) {
      console.warn("runScenario: no scenario id available (no argument and #scenario select not found)");
      return;
    }

    const runBtn = document.querySelector(".scenario-bar .btn.primary, #runScenario, [data-action='run-scenario']");
    const originalLabel = runBtn ? runBtn.textContent : null;
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.textContent = "Solving…";
    }
    setStatus("Solving…", true);

    try {
      // Reuse the prefetched hero-strip result only when it was fetched at the SAME
      // capacity mode we need now -- otherwise a user-selected capacity-mode override
      // would silently render stale data from the wrong mode.
      const natural = scenarioDefaults[id];
      const canReuseCache = heroCache[id] && (!mode || mode === natural);
      const result = canReuseCache ? heroCache[id] : await CrossFlowAPI.pipeline(id, { capacityMode: mode });

      heroCache[id] = result; // keep the hero strip in sync with whatever was actually just shown
      renderMain(result, id);
      refreshMapLiveData();
    } catch (err) {
      console.error("runScenario failed", id, mode, err);
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
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = originalLabel || "Run →";
      }
    }
  }

  window.runScenario = runScenario;
  window.updateScenario = runScenario; // alias in case existing HTML wires onclick="updateScenario()"

  // ---------------------------------------------------------------------------
  // Scenario prefetch
  // ---------------------------------------------------------------------------

  async function prefetchHero(
    defaultCapacity
  ) {
    await Promise.all(
      Object.keys(
        SCENARIO_LABELS
      ).map(
        async (
          sid
        ) => {
          try {
            heroCache[
              sid
            ] =
              await CrossFlowAPI.pipeline(
                sid,
                {
                  capacityMode:
                    defaultCapacity[
                      sid
                    ],
                }
              );
          } catch (
            err
          ) {
            console.warn(
              "scenario prefetch failed",
              sid,
              err
            );
          }
        }
      )
    );
  }

  function syncCapacitySelect(
    scenarioId,
    defaults
  ) {
    const select =
      document.getElementById(
        "capacity"
      );

    if (
      select &&
      defaults[
        scenarioId
      ]
    ) {
      select.value =
        defaults[
          scenarioId
        ];
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    const status =
      document.querySelector(
        ".status"
      );

    if (
      status &&
      !document.getElementById(
        "apiStatusText"
      )
    ) {
      const dot =
        status.querySelector(
          ".dot"
        );

      const existing =
        status.textContent.trim();

      status.innerHTML =
        "";

      if (dot) {
        status.appendChild(
          dot
        );
      }

      const span =
        document.createElement(
          "span"
        );

      span.id =
        "apiStatusText";

      span.textContent =
        existing;

      status.appendChild(
        span
      );
    }

    injectCleanSections();

    cleanStaticRecipeUI();

    fixStaticText();

    setStatus(
      "Connecting…",
      true
    );

    let scenarios;

    try {
      [
        scenarios,
        network,
      ] =
        await Promise.all(
          [
            CrossFlowAPI.scenarios(),
            CrossFlowAPI.network(),
          ]
        );
    } catch (
      err
    ) {
      showConnectionError(
        err
      );

      return;
    }

    Object.values(
      scenarios.scenarios ||
        {}
    ).forEach(
      (s) => {
        scenarioDefaults[
          s.name
        ] =
          s.capacity_mode;
      }
    );

    facilityNames =
      {};

    [
      ...(network.source_nodes ||
        []),

      ...(network.facilities ||
        []),
    ].forEach(
      (node) => {
        facilityNames[
          node.id
        ] =
          node.display_name;
      }
    );

    facilityNames.DECENTRALISED_COMPOST =
      "Decentralised composters & pits";

    // Map stays paused for now.
    renderMap(
      network
    );

    const scenarioSelect =
      document.getElementById(
        "scenario"
      );

    if (scenarioSelect) {
      scenarioSelect.addEventListener(
        "change",
        () =>
          syncCapacitySelect(
            scenarioSelect.value,
            scenarioDefaults
          )
      );

      syncCapacitySelect(
        scenarioSelect.value,
        scenarioDefaults
      );
    }

    await runRecipePreset(
      "mixed"
    );

    setStatus(
      "Loading scenarios…",
      true
    );

    await prefetchHero(
      scenarioDefaults
    );

    // Defensive: even if #scenario is missing/misnamed, still try to render something
    // (the "baseline" scenario id) rather than leaving the page on "Loading scenarios…"
    // forever. Wrapped in its own try/catch so a problem here can never re-produce the
    // original stuck-loading bug -- a failure here now always ends in a visible error
    // state via runScenario's own catch block, never a silent hang.
    try {
      const initialId = scenarioSelect ? scenarioSelect.value : "baseline";
      await runScenario(
        initialId,
        scenarioDefaults[initialId]
      );
    } catch (err) {
      console.error("initial runScenario failed unexpectedly", err);
      setStatus("Scenario error", false);
      setText("decisionTitle", "Could not load the initial scenario");
      setText("decisionText", (err && err.message) || "See the browser console for details.");
    }
  }

  document.addEventListener(
    "DOMContentLoaded",
    init
  );
})();