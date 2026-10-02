# ♻️ CrossFlow

### Operating Intelligence for Distributed Resource Recovery

**CrossFlow** is a decision-intelligence platform for designing and adapting municipal solid-waste processing networks.

Instead of asking:

> **“Which waste-processing technology should we use?”**

CrossFlow asks:

> **“Given the waste, existing infrastructure, available capacity, changing conditions, and useful outputs — what should the network do?”**

It evaluates four network actions:

**BUILD · RETROFIT · REROUTE · DO NOTHING**

The current prototype is built around an **FY2025–26 Delhi baseline**.

---

## 💡 The Idea

Waste-processing decisions are rarely about choosing one technology.

Waste composition changes. Facilities have different capacities. Existing infrastructure may already have usable spare capacity. Weather, festivals, and outages can change the network. And processing waste is only part of the problem — the resulting outputs also need somewhere useful to go.

CrossFlow therefore treats waste processing as a **network optimization problem**:

```text
Waste Profile
     ↓
Technology Compatibility
     ↓
Existing Infrastructure + Capacity
     ↓
Scenario Conditions
     ↓
Network Optimization
     ↓
Why this decision?
     ↓
Recovered Outputs
     ↓
Where can those outputs be useful?
```

> **Optimize the network, not just the technology.**

---

# 🧠 Core Features

### 🧪 Waste Recipe Engine

Evaluates whether a waste stream is compatible with different processing pathways using factors such as:

- organic fraction
- moisture
- contamination
- C:N ratio

Returns compatibility, category, risk, confidence, and limiting factors.

The Recipe Engine is an **advisory compatibility layer** — it does not silently override network optimization.

---

### ♻️ Hybrid Processing Optimizer

Optimizes allocations across existing and candidate facilities rather than assuming a single processing technology.

Possible actions:

**BUILD · RETROFIT · REROUTE · DO NOTHING**

Supports:

- **TOTAL_NETWORK** capacity
- **INCREMENTAL_SPARE** capacity

using a MILP-based optimization model.

---

### 🎯 Output-First Matching

CrossFlow goes beyond:

> “Where can the waste go?”

and considers:

> **“Where can the recovered output actually be useful?”**

The output-matching layer connects:

**Processing → Recovered Output → Demand → Match**

Current modelling includes outputs such as recovered power and compost.

---

### 🌧️ Scenario & Failure Simulation

The network can be evaluated under different conditions, including:

- Baseline
- Ghazipur outage
- Monsoon surge
- Festival surge
- Spare-capacity scenario

This shows how network allocations change when conditions change.

---

### 🧠 Explainable Why Engine

Every major optimization decision is accompanied by structured reasoning derived from the actual pipeline.

Instead of only showing *what* CrossFlow decided, the system also explains *why*.

---

### 💰 Economics & Impact

CrossFlow evaluates annualized economic and lifecycle implications using the available model inputs.

Results retain their provenance:

**OBSERVED · DERIVED · ASSUMED · MODELLED**

so prototype assumptions are not presented as official observed values.

---

### 🏗️ Existing Infrastructure & Spare Capacity

CrossFlow considers infrastructure that already exists before assuming that new infrastructure should be built.

Conceptually:

```text
Nameplate Capacity
        ↓
Current Load
        ↓
Spare Capacity
        ↓
CrossFlow Allocation
        ↓
Remaining Capacity
```

---

# 🏗️ Architecture

```text
┌──────────────────────┐
│   Frontend           │
│   HTML / CSS / JS    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Python API         │
│   api/server.py      │
└──────────┬───────────┘
           │
           ▼
┌────────────────────────────┐
│     CrossFlow Pipeline     │
│                            │
│ Optimizer                 │
│ Recipe Engine             │
│ Why Engine                │
│ Output Matching           │
│ Economics                 │
│ Scenarios                 │
└──────────┬─────────────────┘
           │
           ▼
┌──────────────────────┐
│      Data Pack       │
│ Provenance + Baseline│
│ + Explicit Assumptions│
└──────────────────────┘
```

The frontend communicates with the backend through:

```text
GET /api/health
GET /api/scenarios
GET /api/network
GET /api/pipeline/<scenario>
GET /api/recipe
```

---

# 🛠️ Tech Stack

**Frontend**
- HTML
- CSS
- Vanilla JavaScript
- Leaflet

**Backend**
- Python
- MILP optimization
- Linear programming
- Rule-based feedstock compatibility
- Lightweight HTTP API

**Data**
- JSON
- CSV
- Provenance-aware modelling

---

# 📁 Project Structure

```text
CrossFlow/
├── frontend/
│   ├── index.html
│   └── js/
│       ├── app.js
│       └── api-client.js
│
├── data_pack/
│   ├── provenance.csv
│   ├── conflicts.csv
│   ├── recipe_thresholds.json
│   └── primary_2025_26/
│
└── localloop/
    └── backend/
        ├── api/
        │   └── server.py
        ├── engine/
        │   ├── optimizer.py
        │   ├── scenarios.py
        │   ├── explain.py
        │   ├── outputs.py
        │   ├── recipe.py
        │   ├── economics.py
        │   ├── pipeline.py
        │   └── ...
        ├── tests/
        ├── run_demo.py
        └── FREEZE_REPORT.md
```

`localloop` is retained as an internal/historical Python module path.

---

# 📊 Data Philosophy

CrossFlow is deliberately **provenance-aware**.

The system distinguishes between:

| Label | Meaning |
|---|---|
| **KNOWN / OBSERVED** | Directly sourced information |
| **DERIVED** | Calculated from sourced values |
| **ASSUMPTION** | Explicit prototype input |
| **MODELLED** | Generated by the decision/economic models |
| **PENDING / UNKNOWN** | Not reliably available |

This matters because some facility-level information required for a complete real-world optimization is not publicly available at sufficient granularity.

### Two Modes

**VALIDATED**

Uses supported sourced/derived values and refuses to silently fill missing information.

**DEMO**

Adds explicitly labelled assumptions where necessary so the complete pipeline can be demonstrated end-to-end.

> **No fabricated values are presented as observed facts.**

---

# ▶️ Running CrossFlow

## Start the backend

From the repository root:

```bash
cd localloop/backend
python -m api.server
```

The API runs at:

```text
http://localhost:8000
```

Check:

```text
http://localhost:8000/api/health
```

## Start the frontend

In another terminal:

```bash
cd frontend
python -m http.server 5500
```

Then open:

```text
http://localhost:5500
```

---

# 🧪 Backend Tests

From:

```bash
cd localloop/backend
```

Run:

```bash
python -m tests.test_optimizer
python -m tests.test_engines
```

The backend currently contains **57 tests**.

The demo pipeline can also be run directly:

```bash
python run_demo.py baseline
```

Available scenarios include:

```text
baseline
ghazipur_outage
festival_surge_mcd_20pct
monsoon_surge_30pct
spare_capacity_demo
```

For the detailed backend contract and freeze results:

```text
localloop/backend/FREEZE_REPORT.md
```

---

# 🇮🇳 Current Scope

CrossFlow is a **decision-support prototype**, not a production municipal control system.

The current implementation is based on an FY2025–26 Delhi baseline and uses public data wherever possible. Where the public data is insufficient for a complete end-to-end demonstration, assumptions are explicitly labelled.

This makes the prototype suitable for:

- scenario exploration
- network-level planning concepts
- optimization demonstrations
- explainable decision support
- hackathon prototyping

but not as an official municipal allocation system.

---

# 🚀 Future Directions

Potential extensions include:

- richer locality-level waste profiles
- live municipal data
- additional processing pathways
- richer transport modelling
- uncertainty-aware optimization
- facility telemetry
- multi-locality deployment
- municipal planning APIs

---

## 🏆 Built for WasteChakra Round 2

**CrossFlow**  
*Operating Intelligence for Distributed Resource Recovery*

**Optimize the network, not just the technology.**