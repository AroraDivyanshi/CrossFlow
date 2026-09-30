# Validation Report — DELHI_2025_26_PRIMARY

**Dataset label:** FY2025-26 official Delhi baseline + verified subset of facility nodes.
**Baseline status:** CURRENT_OFFICIAL_WITH_INTERNAL_CONFLICT

Scope note: everything under `city_reference_metrics`, `facility_subset` and `okhla_compost_plant`
came from the Economic Survey of Delhi 2025-26 as relayed by the user (I could not open
`delhiplanning.delhi.gov.in` — it blocks automated fetches) plus two press reports that cite the
same survey. So "KNOWN" here means *user-verified against the official PDF*, not
assistant-verified. I checked arithmetic and cross-source consistency only.

---

## 1. Arithmetic checks

| ID | Check | Result |
|---|---|---|
| D2 | 11,500 (MCD) + 300 (NDMC) + 62 (DCB) = 11,862 | **Passes** |
| D3 | 7,460.3 / 11,862 = 62.9%; 7,641 / 11,862 = 64.4% | **Passes** (matches both press write-ups) |
| new | 1,550 + 2,400 + 1,300 + 2,000 = 7,250 (facility_subset sum) | **Passes as arithmetic**, but per your instruction this is *not* checked against 7,641 — different metrics (§4) |
| new | 7,250 (subset) + 20 + 20 + 252 (installed decentralised) = 7,542 vs city 7,641 | **Off by 99 TPD.** Not flagged as an error — see §4; kept as an open note (C27), not a required reconciliation |
| new | Named proposed projects: 1,000 + 300 + 350 = 1,650 vs reported total 7,750 | **Off by 6,100 TPD.** Per your instruction, not reconstructed or forced — flagged as incomplete (C28) |
| new | Two processing-gap readings: 11,862 − 7,641 = 4,221 (press rounds to "~4,200"); 11,862 − 7,460.3 = 4,401.7 | Both **pass as arithmetic**, but they answer different questions (installed-capacity gap vs actual-processing gap) — recorded, not collapsed into one "the gap" figure |

## 2. Values whose definitions may differ (do not combine)

| Pair | Values | Why they're kept apart |
|---|---|---|
| Composters/pits/MRF: **installed capacity** vs **reported throughput** | 20/20/252 (Statement 14.10, per you) vs 558 (pits) / 293 (MRF) (press) | Capacity ("can handle up to") and throughput ("actually processed") are different metrics even for the same facility type; the press figures may also cover a different count of pits (257) than whatever backs the "20" figure |
| City **installed_capacity_tpd** (7,641) vs facility_subset **sum** (7,250) | different scope | 7,641 is a city-wide reported number; 7,250 sums only 4 named WTE/integrated facilities. The city figure almost certainly includes capacity outside this subset (decentralised processing, possibly other facilities not yet named). They are not meant to reconcile, and I stopped treating the gap as an error per your instruction |
| **installed_capacity_tpd** (7,641) vs **actual_reported_processing_tpd** (7,460.3) | capacity vs throughput, city-wide | Same capacity/throughput distinction as above, at city scale |
| MCD generation: 11,500 (Statement 8.4) vs 12,500 (unspecified other section) | same nominal variable, two values | C22 — unresolved; I use 11,500 provisionally because it's the one that sums to 11,862 (D2) |

## 3. KNOWN / PENDING / UNKNOWN inventory

**KNOWN** (stated in the survey per you, or arithmetic derived from KNOWN inputs):
- MCD 11,500 / NDMC 300 / DCB 62 / total 11,862 TPD generation (Statement 8.4)
- 250 MCD wards; 100% collection; 59% average MCD segregation
- Okhla 1,550 / Narela-Bawana integrated 2,400 / Ghazipur 1,300 / Tehkhand 2,000 TPD (Statement 14.10) — subset sum 7,250 (derived)
- Decentralised installed capacity: composters 20, compost pits 20, MRF 252 TPD (Statement 14.10)
- Decentralised reported throughput: compost pits 558 TPD (257 pits), MRF 293 TPD (press)
- Proposed: Tehkhand +1,000; Okhla Bio-CNG 300; Ghazipur CBG 350; reported total proposed 7,750 TPD

**PENDING_VERIFICATION:**
- City installed_capacity_tpd 7,641 and actual_reported_processing_tpd 7,460.3 — seen only in press coverage of the survey, not yet in a numbered Statement
- MCD generation 12,500 (S21) — statement/table not yet specified
- Okhla compost plant: status and its 200 TPD figure — downgraded this turn from an assumed "closed" to PENDING, since that description sat inside the Bio-CNG project text, not confirmed as the compost plant's own reported status field

**UNKNOWN** (no source at all, not fabricated):
- Source-node centroids and zone boundaries (MCD, NDMC, DCB)
- Operating status of all 4 subset facilities
- Current load/throughput of any individual facility
- Processing cost per facility
- Facility coordinates
- Inter-node distance matrix and transport cost per tonne-km
- Output demand (compost, power, recyclables, CBG offtake)
- Zone/ward-level generation

## 4. Double-counting check

- **7,641 is not summed with, or checked against, the facility_subset.** Per instruction, it's stored as an independent city-level metric with its own provenance and metric definition, not a target the four facilities must add up to.
- **Decentralised capacity and throughput are stored as two separate series** (`installed_capacity_tpd` vs `reported_throughput_tpd`) with an explicit `do_not` field telling any future code not to sum them.
- **The 7,750 proposed-capacity total is not reconstructed from named projects.** The three projects I have (1,650 TPD) are stored separately from the reported total, with an explicit `reconciliation_status` field, so nothing downstream can accidentally add them together and call it 7,750.
- **No value appears twice under different names in the JSON** that I could find — each figure has one home (`city_reference_metrics`, `facility_subset`, `decentralised_processing`, or `proposed_capacity_projects`).

## 5. Remaining blockers to a real optimization run

Even with this baseline locked, `engine/loader.py` would still report these as missing before `solve()` could run on real data:
1. Facility operating status (all 4 subset facilities, plus Okhla compost)
2. Facility current load — needed for `spare` mode; without it only `nominal` mode is possible, and even that needs status resolved first
3. Facility processing cost (Rs/tonne)
4. Facility and source-node coordinates
5. Distance matrix and transport cost per tonne-km
6. Output demand nodes (for the output-matching feature)
7. Zone/ward-level generation, if a sub-city locality view is wanted instead of the 3-body (MCD/NDMC/DCB) split

The 3-body split (MCD/NDMC/DCB) is real and dated, but it is a much coarser network than "12 zones" — it has only 3 source nodes. Whether that's sufficient for the demo, or whether zone-level generation is still needed, is a scope decision rather than a data-availability one at this point.

## 6. Files in this snapshot
- `network_2025_26.json` — the locked data model, restructured per your 8 points
- `VALIDATION_REPORT.md` — this report
- `provenance.csv`, `conflicts.csv` (in the parent `data_pack/` folder) — updated with C24/C26/C27/C28 reclassified and new C29
