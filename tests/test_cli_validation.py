"""Every core response is validated against the contract schemas (jsonschema)."""

from __future__ import annotations

import time

import pytest

from culture_agents.cli import _contract
from culture_agents.cli._client import error_from_body
from tests import contract_support as cs
from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture, sse_frame, stream_events

API = cs.api_index()

#: (schema file stem, fixture target) -> payload name in ``_contract.TARGETS``.
NAMES = {
    (target.split(".json")[0], target.split("$defs/")[-1] if "#" in target else "root"): name
    for name, target in _contract.TARGETS.items()
}


def _fixtures(kind: str):
    for path in cs.fixtures(kind):
        key = (path.parent.name, path.name.split(".", 1)[0])
        if key in NAMES:
            yield pytest.param(path, NAMES[key], id=f"{path.parent.name}/{path.name}")


def test_every_response_schema_of_a_cli_route_has_a_validator() -> None:
    routed = {r["response"] for r in API["routes"] if r["response"] and r["cli"] != "none in D1"}
    routed.discard("capabilities.json#/$defs/capabilities_list")  # the CLI never calls it
    assert routed <= set(_contract.TARGETS.values())
    assert _contract.TARGETS["error"] == "error.json"
    assert _contract.ID_BASE == cs.ID_BASE


@pytest.mark.parametrize(("path", "name"), _fixtures("valid"))
def test_every_valid_fixture_is_accepted(path, name: str) -> None:
    assert _contract.problem(name, cs.load_json(path)) is None


@pytest.mark.parametrize(("path", "name"), _fixtures("invalid"))
def test_every_invalid_fixture_is_rejected(path, name: str) -> None:
    assert _contract.problem(name, cs.load_json(path))


@pytest.mark.parametrize("path", sorted((cs.FIXTURES / "streams" / "valid").glob("*.jsonl")))
def test_every_stream_fixture_event_is_accepted(path) -> None:
    assert [_contract.problem("event", e) for e in cs.read_stream(path)].count(None) == len(
        cs.read_stream(path)
    )


def test_a_problem_names_where_and_what() -> None:
    run_payload = fixture("run", "root.running")
    assert _contract.problem("run", {**run_payload, "state": "bogus"}).startswith("$")
    assert "bogus" in _contract.problem("run", {**run_payload, "state": "bogus"})
    assert "surprise" in _contract.problem("run", {**run_payload, "surprise": 1})
    assert _contract.problem("run", {**run_payload, "cursor": True})  # a bool is not an integer
    assert _contract.problem("run_list", {"runs": "none"})
    assert _contract.problem("event", [])
    assert _contract.problem("event", None)
    huge = _contract.problem("run", {**run_payload, "task": 7, "state": "x" * 5000})
    assert len(huge) <= 300
    assert "\x1b" not in _contract.problem("run", {**run_payload, "state": "\x1b[2J"})


def test_validators_are_compiled_once_and_never_fetch() -> None:
    from jsonschema import Draft202012Validator

    assert _contract.validator("run") is _contract.validator("run")
    assert _contract._registry() is _contract._registry()
    outside = Draft202012Validator(
        {"$ref": "https://culture.dev/contract/agents/nowhere.json"}, registry=_contract._registry()
    )
    with pytest.raises(Exception, match="nowhere.json"):
        outside.validate({})


def test_validation_is_fast_enough_not_to_matter() -> None:
    events = stream_events()
    _contract.problem("event", events[0])  # compile
    started = time.perf_counter()
    for _ in range(100):
        for event in events:
            assert _contract.problem("event", event) is None
    assert time.perf_counter() - started < 5.0  # 700 events; measured at well under a second


# --- through the CLI -----------------------------------------------------------


@pytest.mark.parametrize(
    "change", [{"state": "bogus"}, {"surprise": True}, {"cursor": 0}], ids=["enum", "extra", "min"]
)
def test_an_invalid_run_is_internal_exit_2_and_is_not_passed_on(core, capsys, change) -> None:
    core.respond("GET /v1/runs/{id}", 200, {**fixture("run", "root.running"), **change})
    for flags in ([], ["--json"]):
        r = run(capsys, "runs", "show", RUN_ID, *flags)
        assert r.rc == 2
        assert r.out == ""
        assert "invalid run payload" in r.err
    assert r.err_json()["error_code"] == "internal"


def test_an_invalid_run_inside_a_list_is_refused(core, capsys) -> None:
    runs = fixture("run", "run_list.two-runs")["runs"]
    core.respond("GET /v1/runs", 200, {"runs": [runs[0], {**runs[1], "state": "paused"}]})
    r = run(capsys, "runs", "list", "--json")
    assert r.rc == 2
    assert r.out == ""
    assert r.err_json()["error_code"] == "internal"


def test_an_invalid_capability_document_is_refused(core, capsys) -> None:
    doc = fixture("capabilities", "root.claude-code")
    broken = {**doc, "capabilities": {**doc["capabilities"], "steer": "yes"}}
    listing = {**fixture("agent", "agent_list.two-agents"), "harnesses": [broken]}
    core.respond("GET /v1/agents", 200, listing)
    r = run(capsys, "agents", "list")
    assert r.rc == 2
    assert r.out == ""
    assert r.err.startswith("error: the core sent an invalid agent_list payload")


def test_an_invalid_event_on_the_attach_stream_is_refused(core, capsys) -> None:
    events = stream_events()
    bad = {**events[2], "data": {"channel": "shout", "text": "x"}}
    core.attach_cutoffs = [b"".join(sse_frame(e) for e in (events[0], events[1], bad))]
    r = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert r.rc == 2
    assert len(r.out.splitlines()) == 2  # the two valid events, then nothing
    assert r.err_json()["error_code"] == "internal"
    assert "invalid event" in r.err_json()["message"]


def test_an_error_body_that_breaks_the_schema_is_internal() -> None:
    body = fixture("error", "root.not-found")
    extra = {"error": {**body["error"], "stack": "..."}}
    err = error_from_body(404, extra)
    assert (err.code, err.error_code) == (2, "internal")
    assert "HTTP 404" in err.message


def test_missing_schemas_are_an_environment_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    from culture_agents.cli._errors import CliError

    monkeypatch.setattr(_contract, "_CANDIDATES", (tmp_path / "a", tmp_path / "b"))
    with pytest.raises(CliError) as exc:
        _contract.schema_dir()
    assert exc.value.code == 2
    assert exc.value.remediation
