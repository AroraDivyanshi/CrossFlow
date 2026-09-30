"""
Typed data states for LocalLoop.

Every numeric input is wrapped in a Field carrying its state, value, year,
provenance (source row ids) and evidence text. Nothing reaches the optimizer
as a bare float -- it always goes through Field.require(name, mode), so a
value that is not sourced for the requested mode raises MissingDataError
instead of silently being treated as zero or omitted.

Two modes:
  VALIDATED -- accepts only KNOWN and DERIVED. Rejects ASSUMPTION, PENDING,
               UNRESOLVED, UNKNOWN. This is the evidence-backed analysis mode.
  DEMO      -- additionally accepts ASSUMPTION. An ASSUMPTION field MUST carry
               non-empty evidence text (enforced in __post_init__) explaining
               what was assumed and why -- it can never silently stand in for
               official data. PENDING/UNRESOLVED/UNKNOWN are still rejected
               even in DEMO mode: those mean "we looked and don't know",
               which is different from "we're assuming X for the prototype".
"""
from dataclasses import dataclass, field
from enum import Enum


class State(str, Enum):
    KNOWN = "KNOWN"                    # directly reported in a cited source
    DERIVED = "DERIVED"                # computed from KNOWN/DERIVED inputs, formula shown
    ASSUMPTION = "ASSUMPTION"          # explicitly labelled prototype assumption (DEMO only)
    PENDING = "PENDING_VERIFICATION"   # seen somewhere, not yet confirmed against a primary source
    UNRESOLVED = "UNRESOLVED"          # sources conflict and it hasn't been settled
    UNKNOWN = "UNKNOWN"                # no source found at all


VALIDATED_STATES = (State.KNOWN, State.DERIVED)
DEMO_STATES = (State.KNOWN, State.DERIVED, State.ASSUMPTION)
MODES = ("validated", "demo")


class MissingDataError(Exception):
    """Raised when a Field is not usable in the requested mode."""


@dataclass(frozen=True)
class Field:
    state: State = State.UNKNOWN
    value: float | None = None
    year: str | None = None
    provenance: tuple = ()
    evidence: str = ""

    def __post_init__(self):
        if self.state == State.ASSUMPTION and not self.evidence.strip():
            raise ValueError(
                "ASSUMPTION fields must carry non-empty evidence explaining the assumption; "
                "an unlabelled guess is not permitted even in DEMO mode."
            )

    def usable(self, mode: str = "validated") -> bool:
        if mode not in MODES:
            raise ValueError(f"unknown mode {mode!r}, expected one of {MODES}")
        allowed = VALIDATED_STATES if mode == "validated" else DEMO_STATES
        return self.state in allowed and self.value is not None

    def require(self, name: str, mode: str = "validated") -> float:
        if not self.usable(mode):
            raise MissingDataError(f"[{mode}] {name}: state={self.state.value}")
        return float(self.value)

    def as_dict(self):
        """API/frontend-facing shape: always exposes which bucket a value is in."""
        label = {"KNOWN": "OBSERVED", "DERIVED": "DERIVED", "ASSUMPTION": "ASSUMED"}.get(
            self.state.value, self.state.value
        )
        return {
            "value": self.value,
            "label": label,
            "state": self.state.value,
            "year": self.year,
            "provenance": list(self.provenance),
            "evidence": self.evidence,
        }


def known(value, year=None, provenance=(), evidence=""):
    return Field(State.KNOWN, value, year, tuple(provenance), evidence)


def derived(value, provenance=(), evidence=""):
    return Field(State.DERIVED, value, provenance=tuple(provenance), evidence=evidence)


def assumption(value, evidence, provenance=()):
    """Convenience constructor -- forces the caller to supply evidence text."""
    if not evidence or not evidence.strip():
        raise ValueError("assumption() requires non-empty evidence text")
    return Field(State.ASSUMPTION, value, provenance=tuple(provenance), evidence=evidence)


@dataclass
class Facility:
    id: str
    capacity: Field = field(default_factory=Field)             # existing/nameplate capacity, TPD
    load: Field = field(default_factory=Field)                 # current load, TPD
    proc_cost: Field = field(default_factory=Field)            # Rs/tonne
    env_cost: Field = field(default_factory=lambda: Field(State.KNOWN, 0.0))
    status: str = "operating"                                   # "operating" | "outage" | "UNRESOLVED" | ...
    is_candidate: bool = False                                   # BUILD candidate (does not exist yet)
    build_capex_annual: Field = field(default_factory=Field)     # Rs/year, annualised, if built
    build_cap_tpd: Field = field(default_factory=Field)          # capacity added if built
    retrofit_cost_annual: Field = field(default_factory=Field)
    retrofit_adds_tpd: Field = field(default_factory=Field)

    def spare(self, mode: str = "validated") -> Field:
        """DERIVED only when both capacity and load are usable in this mode.
        Never guessed -- an UNKNOWN load means UNKNOWN spare, full stop."""
        if self.capacity.usable(mode) and self.load.usable(mode):
            return Field(
                State.DERIVED,
                self.capacity.value - self.load.value,
                provenance=tuple(self.capacity.provenance) + tuple(self.load.provenance),
                evidence="derived: capacity - load",
            )
        return Field(State.UNKNOWN)


@dataclass
class Instance:
    supply: dict                                    # node_id -> Field (generation, TPD)
    facilities: dict                                # facility_id -> Facility
    dist_km: dict                                   # (node_id, facility_id) -> Field
    transport_rs_tkm: Field = field(default_factory=Field)
    landfill_cost: Field = field(default_factory=Field)         # Rs/tonne
    landfill_env: Field = field(default_factory=Field)          # env cost/tonne, landfill
    weights: dict = field(default_factory=lambda: {"proc": 1.0, "trans": 1.0, "env": 1.0, "infra": 1.0})
    budget_annual: Field = field(default_factory=Field)          # optional cap on annualised infra spend
    mode: str = "validated"
    city_reference_capacity_tpd: Field = field(default_factory=Field)
    # City-level reported installed capacity (e.g. 7,641 TPD). Kept for display/reporting
    # ONLY -- never compared against, netted with, or used to bound facility_subset capacity.
    # See UNMODELED_CITY_CAPACITY in the demo scenario for why.
