"""Contract 3.0, plan task t30: what part two needs is in the schemas, so it adds no MAJOR bump.

Two things were left undecided in 3.0: ``placement`` becoming supportable, and a typed
refusal of a submit that an admission signal holds. Both are shapes now and behaviour later
(planned, part two): every harness still reports ``placement`` unsupported, and no route
returns ``admission_held`` yet. These tests fix the shapes and check them from both the test
validator (``tests/contract_support.py``) and the CLI's runtime validator.
"""

from __future__ import annotations

import pytest

from culture_agents.cli import _contract
from tests import contract_support as cs

API = cs.api_index()
SCHEMAS = cs.load_schemas()
REG = cs.registry()
README = (cs.CONTRACT / "README.md").read_text(encoding="utf-8")

PLACEMENT_VALID = "capabilities/root.placement-supported-with-caveat"
PLACEMENT_INVALID = ("capabilities/root.type-placement-unsupported-without-reason",)
HELD_VALID = ("error/root.admission-held-heat", "error/root.admission-held-gateway-unknown")
HELD_INVALID = (
    "error/root.required-admission-held-without-signal",
    "error/root.const-admission-held-not-retryable",
    "error/root.enum-held-signal-name-unknown",
    "error/root.enum-held-signal-state-admit",
    "error/root.required-held-signal-without-observed-at",
    "error/root.not-signal-on-limit-reached",
)


def _load(name: str, kind: str = "valid"):
    return cs.load_json(cs.FIXTURES / kind / f"{name}.json")


def _errors(name: str, kind: str) -> list[str]:
    path = cs.FIXTURES / kind / f"{name}.json"
    validator = cs.validator_for(cs.fixture_target(path), REG)
    return [e.message for e in validator.iter_errors(cs.load_json(path))]


# --- placement ------------------------------------------------------------------


def test_placement_uses_the_supportable_capability_shape():
    props = SCHEMAS["capabilities.json"]["$defs"]["capability_set"]["properties"]
    assert props["placement"]["$ref"].endswith("#/$defs/capability")
    deferred = SCHEMAS["capabilities.json"]["$defs"]["deferred"]["description"]
    assert "placement" not in deferred


def test_a_report_with_placement_supported_and_a_caveat_validates():
    assert _errors(PLACEMENT_VALID, "valid") == []
    placement = _load(PLACEMENT_VALID)["capabilities"]["placement"]
    assert placement["supported"] is True and placement["reason"] is None
    assert placement["caveats"]
    assert _contract.problem("capabilities", _load(PLACEMENT_VALID)) is None


@pytest.mark.parametrize("name", PLACEMENT_INVALID)
def test_placement_unsupported_still_needs_a_reason(name):
    assert _errors(name, "invalid")
    assert _contract.problem("capabilities", _load(name, "invalid")) is not None


# --- admission_held ---------------------------------------------------------------


def test_admission_held_is_one_new_retryable_user_error_on_submit():
    codes = SCHEMAS["error.json"]["$defs"]["code"]["enum"]
    assert "admission_held" in codes and set(codes) == set(API["errors"])
    row = API["errors"]["admission_held"]
    assert (row["http_status"], row["exit_code"], row["retryable"]) == (429, 1, True)
    submit = next(r for r in API["routes"] if r["id"] == "runs.submit")
    assert "admission_held" in submit["errors"]
    others = [r for r in API["routes"] if r["id"] != "runs.submit"]
    assert all("admission_held" not in r["errors"] for r in others)


def test_the_held_signal_names_the_signal_its_state_and_its_observed_time():
    held = SCHEMAS["error.json"]["$defs"]["held_signal"]
    assert set(held["required"]) == {"name", "state", "observed_at"}
    assert held["properties"]["name"]["$ref"] == "capabilities.json#/$defs/signal_name"
    assert held["properties"]["state"]["enum"] == ["hold", "unknown"]


@pytest.mark.parametrize("name", HELD_VALID)
def test_valid_held_refusals_pass_both_validators(name):
    assert _errors(name, "valid") == []
    body = _load(name)
    assert _contract.problem("error", body) is None
    error = body["error"]
    assert (error["code"], error["retryable"]) == ("admission_held", True)
    assert error["signal"]["name"] in ("heat", "gateway")
    assert "observed_at" in error["signal"]


def test_the_two_valid_refusals_cover_both_signals_and_a_missing_reading():
    signals = [_load(n)["error"]["signal"] for n in HELD_VALID]
    assert {s["name"] for s in signals} == {"heat", "gateway"}
    assert {s["state"] for s in signals} == {"hold", "unknown"}
    assert None in {s["observed_at"] for s in signals}


@pytest.mark.parametrize("name", HELD_INVALID)
def test_invalid_held_refusals_are_rejected_by_both_validators(name):
    assert _errors(name, "invalid")
    assert _contract.problem("error", _load(name, "invalid")) is not None


# --- the record -------------------------------------------------------------------


def _section(heading: str) -> str:
    start = README.index(heading)
    return README[start : README.index("\n## ", start + 1)]


def test_readme_no_longer_leaves_placement_and_held_submits_undecided():
    changes = _section("## Changes from 2.0")
    assert "not decided here" not in changes
    assert "without a MAJOR bump" in changes
    for token in ("`placement`", "`admission_held`"):
        assert token in changes, token
    assert changes.count("(planned, part two)") >= 2


def test_readme_moves_placement_out_of_the_deferred_table():
    start = README.index("### Deferred capabilities")
    deferred = README[start : README.index("### Capabilities that 3.0 allows")]
    assert "`placement`" not in deferred
    allowed = README[README.index("### Capabilities that 3.0 allows") :]
    allowed = allowed[: allowed.index("\n### ")]
    assert "`placement`" in allowed and "(planned, part two)" in allowed


def test_readme_error_table_has_the_held_refusal():
    errors = _section("## Errors and CLI exit codes")
    row = next(line for line in errors.splitlines() if line.startswith("| `admission_held`"))
    assert "429" in row and "| 1 |" in row and "true" in row and "`signal`" in row
