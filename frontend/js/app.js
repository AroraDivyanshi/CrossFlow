/**
 * CrossFlow frontend application logic.
 *
 * Renders real engine.pipeline.run_pipeline() responses (via CrossFlowAPI) into V11's
 * existing DOM structure. No optimizer/economics/decision logic is duplicated here --
 * every number shown is read directly off the API response. The few places this file
 * computes something (headline decision, KPI color bands, compact number formatting)
 * are pure display concerns, documented inline, and never alter what the backend decided.
 *
 * SCOPE OF THIS STEP: scenario selection, the hero scenario-signal strip, the four KPI
 * cards, the decision card, and the landfill-pressure/lifecycle-impact analytics panels
 * are wired to real data. The Delhi map, the Recipe Lab's four feedstock presets, and the
 * "How CrossFlow thinks" dial remain the V11 illustrative/static content for now -- the
 * recipe engine's real output shape (compatibility_score/confidence/limiting_factors)
 * doesn't line up with the mockup's FIT/YIELD/RISK/EVIDENCE framing closely enough to wire
 * honestly without inventing numbers the backend doesn't compute, and the map needs real
 * geography work. Both are later steps, not skipped by oversight.
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
  const DECISION_ICON = { BUILD: "\u2726", RETROFIT: "\u2699", REROUTE: "\u21BB", DO_NOTHING: "\u25CF" };

  // Recipe Lab presets: these are EXAMPLE FEEDSTOCK INPUTS (what you'd dial in for a waste
  // stream), not backend outputs -- every number below goes INTO engine.recipe.evaluate() via
  // GET /api/recipe, same as the backend's own default demo feedstock. Nothing about a method's
  // score/category/confidence is decided here; that all comes back from the real API call.
  const RECIPE_PRESETS = {
    mixed: { label: "mixed MSW", organic_fraction: 0.40, moisture_pct: 55, contamination_pct: 12, cn_ratio: 28 },
    wet: { label: "wet organics", organic_fraction: 0.72, moisture_pct: 68, contamination_pct: 6, cn_ratio: 24 },
    dry: { label: "dry recoverables", organic_fraction: 0.22, moisture_pct: 18, contamination_pct: 15, cn_ratio: 55 },
    highmoisture: { label: "surge mix", organic_fraction: 0.45, moisture_pct: 78, contamination_pct: 14, cn_ratio: 30 },
  };
  // Recipe Lab's 4 factor slots, mapped to REAL recipe-engine fields (no fabricated metric):
  //  FIT      -> top method's compatibility_score
  //  CATEGORY -> (relabelled from V11's "YIELD" -- the recipe engine has no yield/energy-recovery
  //               concept; that belongs to a different engine entirely) top method's category,
  //               bar width reuses the same compatibility_score since category IS that score's band
  //  RISK     -> share of evaluated factors that came back limiting (a real ratio, not invented)
  //  EVIDENCE -> top method's confidence band (this slot's own V11 subtitle is literally
  //              "Signal confidence", which is exactly what engine.recipe's `confidence` field is)

  let facilityNames = {}; // filled from /api/network -- real display names, not invented here
  let heroCache = {}; // scenario -> last fetched pipeline result, for the 5-bar hero strip

  // ---------- pure helpers (no DOM access -- safe to reason about/test in isolation) ----------

  function pickHeadline(decisions) {
    const entries = Object.entries(decisions || {});
    if (entries.length === 0) return { fid: null, decision: null };
    const nonDoNothing = entries.find(([, d]) => d !== "DO_NOTHING");
    const [fid, decision] = nonDoNothing || entries[0];
    const allStable = entries.every(([, d]) => d === "DO_NOTHING");
    return { fid, decision, allStable };
  }

  function formatCompact(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  function diversionBand(diversion) {
    // Thresholds are V11's own pre-existing design convention (its original mock code used
    // these exact bands), reused here rather than invented fresh for the real data.
    if (diversion === null) return null;
    if (diversion < 50) return "alert";
    if (diversion < 60) return "warn";
    return null;
  }

  function pressureBand(pressure) {
    if (pressure === null) return null;
    if (pressure >= 65) return "critical";
    if (pressure >= 55) return "alert";
    if (pressure >= 45) return "warn";
    return null;
  }

  function displayName(fid) {
    return (facilityNames[fid] && facilityNames[fid]) || fid || "—";
  }

  function titleCaseDecision(d) {
    return (d || "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---------- DOM rendering ----------

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setStatus(message, ok) {
    const dot = document.querySelector(".status .dot");
    const label = document.getElementById("apiStatusText");
    if (dot) dot.classList.toggle("offline", !ok);
    if (label) label.textContent = message;
  }

  function showConnectionError(err) {
    setStatus("\u26A0 API offline", false);
    setText("decisionTitle", "Can't reach the CrossFlow API");
    setText(
      "decisionText",
      err && err.message
        ? err.message
        : "Start the API server (python3 -m api.server, from localloop/backend) and reload."
    );
    const reasonLine = document.getElementById("reasonLine");
    if (reasonLine) reasonLine.innerHTML = '<span class="reason">NO CONNECTION \u00B7 showing no scenario data</span>';
    ["throughput", "landfill", "diversion", "power"].forEach((id) => setText(id, "\u2014"));
  }

  function renderHeroStrip(selectedScenario) {
    const scenarioChart = document.getElementById("scenarioChart");
    if (!scenarioChart) return;
    scenarioChart.querySelectorAll(".scenario-bar-col").forEach((col) => {
      const sid = col.dataset.scenario;
      const cached = heroCache[sid];
      const fill = col.querySelector(".scenario-bar-fill");
      const value = col.querySelector(".scenario-bar-value");
      col.classList.toggle("active", sid === selectedScenario);
      if (!cached || !cached.economics) return; // leave V11's placeholder bar rather than show 0
      const diversion = cached.economics.landfill_diversion_pct.value;
      if (diversion === null) return;
      const pct = Math.max(0, Math.min(100, diversion));
      fill.style.height = pct + "%";
      value.textContent = Math.round(pct) + "%";
      value.style.bottom = "calc(" + pct + "% - 2px)";
    });
    const selected = heroCache[selectedScenario];
    setText("heroChartScenario", SCENARIO_LABELS[selectedScenario] || selectedScenario);
    if (selected && selected.economics) {
      const diversion = selected.economics.landfill_diversion_pct.value;
      setText("heroDiversion", diversion === null ? "\u2014" : diversion.toFixed(1) + "%");
      const { decision } = pickHeadline(selected.decisions);
      setText("heroDecision", decision ? decision.replace(/_/g, " ") : "\u2014");
    }
  }

  function render(result, scenarioId) {
    const r = result.optimizer_result;
    const econ = result.economics;
    const om = result.output_matching;
    const explanation = result.explanation;
    const decisions = result.decisions || {};
    const capacityMode = (result.capacity_mode || "").toUpperCase();

    setStatus("DEMO \u2022 FY2025\u201326 Delhi Baseline", true);

    if (r.status !== "Optimal") {
      setText("decisionTitle", "Scenario infeasible");
      setText("decisionText", r.message || "The solver could not find a feasible allocation for this input.");
      ["throughput", "landfill", "diversion", "power"].forEach((id) => setText(id, "\u2014"));
      const reasonLine = document.getElementById("reasonLine");
      if (reasonLine) reasonLine.innerHTML = '<span class="reason">INFEASIBLE \u00B7 no allocation to explain</span>';
      return;
    }

    // ---- throughput: real total generation this run (supply actually modeled), not a fixed city constant ----
    const tonnesAllocated = Object.values(r.tonnes_allocated_tpd || {}).reduce((a, b) => a + b, 0);
    const totalGenerated = tonnesAllocated + (r.total_landfilled_tpd || 0);
    setText("throughput", totalGenerated.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    const throughputCard = document.getElementById("throughputCard");
    const throughputNote = throughputCard && throughputCard.querySelector(".note");
    if (throughputNote) {
      throughputNote.textContent =
        capacityMode === "INCREMENTAL_SPARE" ? "TPD \u2022 incremental surge modeled" : "TPD \u2022 main optimizer scope";
    }

    // ---- landfill / diversion ----
    const diversion = econ ? econ.landfill_diversion_pct.value : null;
    const pressure = diversion === null ? null : 100 - diversion;

    const landfillCard = document.getElementById("landfillCard");
    const diversionCard = document.getElementById("diversionCard");
    landfillCard.classList.remove("warn", "alert", "critical");
    diversionCard.classList.remove("warn", "alert");
    const pBand = pressureBand(pressure);
    const dBand = diversionBand(diversion);
    if (pBand) landfillCard.classList.add(pBand);
    if (dBand) diversionCard.classList.add(dBand);

    setText("landfill", (r.total_landfilled_tpd || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }));
    setText("landfillPressure", pressure === null ? "\u2014" : pressure.toFixed(1) + "%");
    setText("landfillState", pressure === null ? "N/A" : "PRESSURE " + pressure.toFixed(1) + "%");
    const pressureFill = document.getElementById("pressureFill");
    if (pressureFill) pressureFill.style.width = Math.min(100, pressure || 0) + "%";

    setText("diversion", diversion === null ? "\u2014" : diversion.toFixed(1) + "%");
    setText(
      "diversionState",
      diversion === null ? "N/A" : diversion >= 80 ? "VERY HIGH" : diversion >= 60 ? "HEALTHY" : diversion >= 50 ? "WATCH" : "LOW"
    );
    const ring = document.getElementById("diversionRing");
    if (ring) {
      const pct = diversion === null ? 0 : diversion;
      ring.style.background = `conic-gradient(var(--teal) 0 ${pct}%, #e6eee9 ${pct}% 100%)`;
      const ringLabel = ring.querySelector("span");
      if (ringLabel) ringLabel.textContent = diversion === null ? "\u2014" : Math.round(diversion) + "%";
    }

    // ---- recovered power output (real demand-matching utilization, not a hardcoded relative max) ----
    const power = om && om.by_output_type && om.by_output_type.power_mwh;
    const powerMatched = power ? power.total_matched_per_day : null;
    const powerUtil = power ? power.utilization_of_recovered_output_pct : null;
    setText("power", powerMatched === null ? "\u2014" : powerMatched.toLocaleString(undefined, { maximumFractionDigits: 1 }));
    setText(
      "powerState",
      capacityMode === "INCREMENTAL_SPARE" ? "SPARE MODE" : powerUtil === null ? "N/A" : powerUtil < 90 ? "PARTIAL MATCH" : "MATCHED"
    );
    const powerFill = document.getElementById("powerFill");
    if (powerFill) powerFill.style.setProperty("--power-width", (powerUtil || 0) + "%");

    // ---- decision card ----
    const { fid, decision, allStable } = pickHeadline(decisions);
    setText("scopeTag", capacityMode || "\u2014");
    setText("moveIcon", (decision && DECISION_ICON[decision]) || "\u25CF");
    if (!fid) {
      setText("decisionTitle", "No facilities in this run");
      setText("decisionText", "This scenario produced no facility decisions to explain.");
    } else if (allStable) {
      setText("decisionTitle", "Network stable");
      setText("decisionText", "Every facility stays at its baseline allocation \u2014 no build, retrofit or reroute is selected.");
    } else {
      setText("decisionTitle", `${titleCaseDecision(decision)} \u2014 ${displayName(fid)}`);
      const info = explanation && explanation.facility_decisions && explanation.facility_decisions[fid];
      setText(
        "decisionText",
        (info && info.reasons && info.reasons[info.reasons.length - 1]) || "No explanation returned for this decision."
      );
    }

    // reason chips -- real backend evidence strings, not rewritten prose. Also where
    // financial cost (feature 6) and the compost auxiliary stream (feature 3) surface --
    // V11 has no dedicated KPI slot for either, and this chip row is the one existing
    // flexible container that can carry extra real evidence without new layout.
    const reasonLine = document.getElementById("reasonLine");
    if (reasonLine) {
      const info = fid && explanation && explanation.facility_decisions && explanation.facility_decisions[fid];
      const chips = [];
      chips.push(`SCOPE \u00B7 ${capacityMode.replace(/_/g, " ").toLowerCase()}`);
      if (info && info.reasons) {
        info.reasons.slice(0, 2).forEach((reason) => chips.push(reason.length > 70 ? reason.slice(0, 67) + "\u2026" : reason));
      }
      if (econ) {
        const fin = econ.financial_cost_rs_per_year;
        chips.push(`FINANCIAL \u00B7 \u20B9${formatCompact(fin.value)}/yr [${fin.label}]`);
      }
      const compost = om && om.by_output_type && om.by_output_type.compost_tonnes;
      if (compost) {
        chips.push(`COMPOST (AUXILIARY) \u00B7 ${compost.total_matched_per_day.toFixed(1)} t/d matched, not in main cost`);
      }
      reasonLine.innerHTML = chips.map((c) => `<span class="reason">${c}</span>`).join("");
    }

    // decision-option tiles: highlight every decision type that actually occurred this run
    const occurring = new Set(Object.values(decisions));
    const tileIds = { BUILD: "buildOption", RETROFIT: "retrofitOption", REROUTE: "rerouteOption", DO_NOTHING: "nothingOption" };
    Object.entries(tileIds).forEach(([decType, elId]) => {
      const el = document.getElementById(elId);
      if (el) el.classList.toggle("active", occurring.has(decType));
    });

    // ---- analytics: landfill pressure stack + lifecycle impact ----
    setText("divertedBar", diversion === null ? "\u2014" : diversion.toFixed(1) + "%");
    const divertedFill = document.getElementById("divertedFill");
    const landfillFill = document.getElementById("landfillFill");
    if (divertedFill) divertedFill.style.width = (diversion || 0) + "%";
    if (landfillFill) landfillFill.style.width = (pressure || 0) + "%";

    const avoided = econ && econ.lifecycle_impact_tco2e_per_year.avoided_emissions.value;
    setText("emissions", avoided === undefined || avoided === null ? "\u2014" : formatCompact(avoided));
    if (econ) {
      setText(
        "impactNote",
        `Counterfactual: compare modeled recovery with an all-landfilled baseline. Financial cost ` +
          `\u20B9${formatCompact(econ.financial_cost_rs_per_year.value)}/yr excludes environmental ` +
          `externality pricing included in the optimizer's own objective (see financial_vs_objective_note).`
      );
    }

    renderHeroStrip(scenarioId);
  }

  // ---------- Recipe Lab (Waste Recipe Engine, feature 5) ----------

  function riskLabel(limitingCount, evaluatedCount) {
    if (evaluatedCount === 0) return { text: "UNKNOWN", pct: 0 };
    const ratio = (limitingCount / evaluatedCount) * 100;
    return { text: ratio === 0 ? "LOW" : ratio < 50 ? "MEDIUM" : "HIGH", pct: ratio };
  }

  function verdictFromCategory(category) {
    return (
      { Compatible: "Strong fit", Marginal: "Partial fit", Incompatible: "Poor fit" }[category] ||
      "Not enough data"
    );
  }

  window.runRecipePreset = async function runRecipePreset(key) {
    const preset = RECIPE_PRESETS[key] || RECIPE_PRESETS.mixed;
    const { label, ...feedstock } = preset;
    try {
      const result = await CrossFlowAPI.recipe(feedstock);
      const top = result.ranked_by_compatibility[0];
      if (!top) {
        setText("recipeText", "Not enough feedstock data was supplied to score any processing method.");
        return;
      }
      const m = result.methods[top];
      const score = m.compatibility_score;
      const risk = riskLabel(m.limiting_factors.length, Number((m.factors_evaluated.match(/(\d+)\//) || [])[1] || 0));

      setText("score", Math.round(score));
      const scoreRing = document.getElementById("scoreRing");
      if (scoreRing) scoreRing.style.background = `conic-gradient(var(--teal) 0 ${score}%,#e0eae5 ${score}% 100%)`;

      setText("recipeInput", label);
      setText("recipeRoute", top.replace(/_/g, " "));
      setText("recipeOutput", m.category === "Incompatible" ? "limited recovery value" : "recoverable value");

      // FIT -- top method's real compatibility_score
      setText("f1v", Math.round(score) + "%");
      document.getElementById("f1").style.width = score + "%";
      setText("f1t", m.confidence + " confidence \u00B7 " + m.factors_evaluated);

      // CATEGORY (relabelled from V11's "YIELD" -- recipe.py has no yield/energy-recovery
      // concept at all; that belongs to engine/outputs.py, a different engine entirely)
      setText("f2v", m.category);
      document.getElementById("f2").style.width = score + "%";
      setText("f2t", "per recipe_thresholds.json bands");

      // RISK -- real ratio of limiting factors among evaluated factors, not invented
      setText("f3v", risk.text);
      document.getElementById("f3").style.width = risk.pct + "%";
      setText(
        "f3t",
        m.limiting_factors.length ? m.limiting_factors.join(", ") + " limiting" : "no limiting factors"
      );

      // EVIDENCE -- this slot's own subtitle is "Signal confidence"; recipe.py's confidence
      // field is exactly that, so no relabel needed here.
      const confidencePct = { HIGH: 100, MEDIUM: 66, LOW: 33, NONE: 0 }[m.confidence] ?? 0;
      setText("f4v", m.confidence);
      document.getElementById("f4").style.width = confidencePct + "%";
      setText("f4t", m.factors_evaluated);

      if (m.limiting_factors.length) {
        setText("limitingTitle", "Watch " + m.limiting_factors[0].replace(/_/g, " "));
      } else {
        setText("limitingTitle", "No limiting factors");
      }
      setText("limitingText", m.explanation);

      setText("recipeState", verdictFromCategory(m.category));
      setText("recipeText", m.explanation);

      const compatEl = document.querySelector(".compat");
      if (compatEl) {
        const chips = [
          m.category !== "Incompatible" ? "\u2713 route compatible" : "\u2715 route marginal",
          m.confidence === "HIGH" ? "\u2713 confidence high" : "\u25B3 confidence " + m.confidence.toLowerCase(),
          m.limiting_factors.length ? "\u25B3 " + m.limiting_factors[0].replace(/_/g, " ") + " watch" : "\u2713 no limiting factors",
          "\u2713 evidence tagged",
        ];
        compatEl.innerHTML = chips
          .map((c) => `<span class="${c.startsWith("\u2713") ? "good" : "warn"}">${c}</span>`)
          .join("");
      }

      setText("recipeMeterValue", Math.round(score) + "%");
      const meter = document.getElementById("recipeMeter");
      if (meter) meter.style.width = score + "%";
    } catch (err) {
      console.error("recipe fetch failed", err);
      setText("recipeText", "Could not reach the recipe engine (" + CrossFlowAPI.BASE + "/recipe).");
    }
  };

  // ---------- Delhi map (real ASSUMED coordinates from /api/network, no fabricated geography) ----------

  function renderMap(network) {
    const el = document.getElementById("leafletMap");
    if (!el || typeof L === "undefined") {
      console.warn("Leaflet not available -- map left blank rather than faked");
      return;
    }
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([28.65, 77.2], 10.3);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    let placed = 0;
    let totalTpd = 0;

    network.source_nodes.forEach((n) => {
      totalTpd += (n.generation_tpd && n.generation_tpd.value) || 0;
      if (!n.coordinates) return;
      placed++;
      L.circleMarker([n.coordinates.lat, n.coordinates.lon], {
        radius: 9,
        color: "#4a5fb3",
        weight: 2,
        fillColor: "#eef2fb",
        fillOpacity: 0.9,
      })
        .addTo(map)
        .bindPopup(
          `<b>${n.display_name}</b><br>${(n.generation_tpd.value || 0).toLocaleString()} TPD generation ` +
            `[${n.generation_tpd.label}]<br><span class="map-pin-badge source">source node</span>` +
            (n.coordinates.state === "ASSUMPTION" ? `<br><small>${n.coordinates.evidence}</small>` : "")
        );
    });

    network.facilities.forEach((f) => {
      if (!f.coordinates) return;
      placed++;
      L.circleMarker([f.coordinates.lat, f.coordinates.lon], {
        radius: 10,
        color: "#159B83",
        weight: 2,
        fillColor: "#e3f3ec",
        fillOpacity: 0.95,
      })
        .addTo(map)
        .bindPopup(
          `<b>${f.display_name}</b><br>${(f.capacity_tpd.value || 0).toLocaleString()} TPD capacity ` +
            `[${f.capacity_tpd.label}]<br><span class="map-pin-badge facility">facility</span>` +
            (f.coordinates.state === "ASSUMPTION" ? `<br><small>${f.coordinates.evidence}</small>` : "")
        );
    });

    const statsEl = document.getElementById("mapStats");
    if (statsEl) {
      statsEl.innerHTML =
        `<span class="map-chip"><b>${network.facilities.length}</b> main facilities</span>` +
        `<span class="map-chip"><b>${totalTpd.toLocaleString()}</b> TPD network</span>` +
        `<span class="map-chip"><b>${placed}</b> plotted</span>` +
        `<span class="map-chip">coords: assumed-state</span>`;
    }
    const captionEl = document.getElementById("mapCaption");
    if (captionEl) captionEl.textContent = network.coordinate_caveat ? "assumed coordinates \u00B7 see pin evidence" : "real coordinates";

    setTimeout(() => map.invalidateSize(), 150); // card may have been 0-height on first paint
  }

  // ---------- orchestration ----------

  async function runScenario(scenarioId, capacityMode) {
    const runBtn = document.querySelector('.scenario-bar .btn.primary');
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.dataset.label = runBtn.textContent;
      runBtn.textContent = "Solving\u2026";
    }
    try {
      const result = await CrossFlowAPI.pipeline(scenarioId, { capacityMode });
      heroCache[scenarioId] = result;
      render(result, scenarioId);
    } catch (err) {
      console.error(err);
      if (err instanceof CrossFlowAPI.ApiError && err.status === 0) {
        showConnectionError(err);
      } else if (err instanceof CrossFlowAPI.ApiError && err.status === 422) {
        // The backend's own honest refusal (e.g. mode=validated has no sourced facility status/
        // load/cost yet) -- surface its real message, don't paper over it with a generic error.
        setText("decisionTitle", "Backend cannot complete this run (missing data)");
        setText("decisionText", err.message);
      } else {
        setText("decisionTitle", "Could not run this scenario");
        setText("decisionText", (err && err.message) || "The API returned an error for this scenario/capacity-mode combination.");
      }
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.textContent = runBtn.dataset.label || "Run \u2192";
      }
    }
  }

  // exposed for the existing V11 inline script (scenario-bar-col click handler, Run button onclick)
  window.updateScenario = function updateScenario() {
    const scenarioSelect = document.getElementById("scenario");
    const capacitySelect = document.getElementById("capacity");
    const scenarioId = scenarioSelect.value;
    const capacityMode = capacitySelect.value;
    runScenario(scenarioId, capacityMode);
  };

  async function prefetchHeroStrip(defaultCapacityByScenario) {
    const ids = Object.keys(SCENARIO_LABELS);
    await Promise.all(
      ids.map(async (sid) => {
        try {
          const result = await CrossFlowAPI.pipeline(sid, { capacityMode: defaultCapacityByScenario[sid] });
          heroCache[sid] = result;
        } catch (err) {
          console.warn("hero prefetch failed for", sid, err);
        }
      })
    );
  }

  function syncCapacitySelectToScenario(scenarioId, defaultCapacityByScenario) {
    const capacitySelect = document.getElementById("capacity");
    const natural = defaultCapacityByScenario[scenarioId];
    if (natural && capacitySelect) capacitySelect.value = natural;
  }

  async function init() {
    // Wrap the nav status text in a span we can update, without changing its visual position.
    const statusEl = document.querySelector(".status");
    if (statusEl && !document.getElementById("apiStatusText")) {
      const dot = statusEl.querySelector(".dot");
      const text = statusEl.textContent.trim();
      statusEl.innerHTML = "";
      if (dot) statusEl.appendChild(dot);
      const span = document.createElement("span");
      span.id = "apiStatusText";
      span.textContent = text;
      statusEl.appendChild(span);
    }
    const footer = document.querySelector(".footer");
    if (footer) {
      footer.textContent =
        "Scenario, KPI and decision data are live from the CrossFlow API (" +
        CrossFlowAPI.BASE +
        "). Delhi map, Recipe Lab presets and the thinking-loop narrative are illustrative pending a later step. Map geometry is illustrative.";
    }

    setStatus("Connecting\u2026", true);

    let scenarios, network;
    try {
      [scenarios, network] = await Promise.all([CrossFlowAPI.scenarios(), CrossFlowAPI.network()]);
    } catch (err) {
      showConnectionError(err);
      return;
    }

    const defaultCapacityByScenario = {};
    Object.values(scenarios.scenarios).forEach((s) => {
      defaultCapacityByScenario[s.name] = s.capacity_mode;
    });

    facilityNames = {};
    [...network.source_nodes, ...network.facilities].forEach((n) => {
      facilityNames[n.id] = n.display_name;
    });

    renderMap(network);
    runRecipePreset("mixed"); // Recipe Lab is independent of scenario selection -- advisory only

    const scenarioSelect = document.getElementById("scenario");
    scenarioSelect.addEventListener("change", () => {
      syncCapacitySelectToScenario(scenarioSelect.value, defaultCapacityByScenario);
    });
    syncCapacitySelectToScenario(scenarioSelect.value, defaultCapacityByScenario);

    setStatus("Loading scenarios\u2026", true);
    await prefetchHeroStrip(defaultCapacityByScenario);

    // initial render: baseline, at its natural capacity mode
    await runScenario(scenarioSelect.value, defaultCapacityByScenario[scenarioSelect.value]);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
