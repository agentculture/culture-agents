"""API 3.x on the CLI side: a 2.0 client and a 3.x core refuse each other, and the new shapes.

The fake core serves the contract's own fixtures, so its ``/v1/version`` answer
is the 3.2 one (3.0 plus the fleet member list, t22, and remote runs, t23). A
"2.0 client" is this CLI with its version constant set back.
"""

from __future__ import annotations

import pytest

from culture_agents.cli import _client, _contract, _stream
from culture_agents.cli._client import EXIT_FOR_CODE, error_from_body
from tests import contract_support as cs
from tests.cli_support import run
from tests.fake_core import fixture

API = cs.api_index()


def test_this_client_speaks_3_2() -> None:
    assert _client.CLIENT_API_VERSION == "3.2" == API["api_version"]


@pytest.mark.parametrize("argv", [("runs", "list"), ("agents", "list"), ("runs", "show", "x")])
def test_a_2_0_client_is_refused_by_a_3_0_core_with_exit_2_naming_both_versions(
    core, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, argv
) -> None:
    monkeypatch.setattr(_client, "CLIENT_API_VERSION", "2.0")
    assert fixture("version", "root.current")["api_version"] == "3.2"
    r = run(capsys, *argv)
    assert r.rc == 2
    assert r.out == ""
    assert "this client speaks 2.0" in r.err
    assert "the core speaks 3.2" in r.err
    assert "hint:" in r.err
    # The client stopped at the version route: nothing else was asked of the core.
    assert [q["path"] for q in core.requests] == ["/v1/version"]
    assert {q["version_header"] for q in core.requests} == {"2.0"}

    j = run(capsys, *argv, "--json")
    assert j.rc == 2
    detail = j.err_json()
    assert (detail["client_api_version"], detail["server_api_version"]) == ("2.0", "3.2")


def test_a_3_0_client_is_refused_by_a_2_0_core_the_same_way(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "api_version": "2.0"}
    )
    r = run(capsys, "runs", "list")
    assert r.rc == 2
    assert "this client speaks 3.2" in r.err
    assert "the core speaks 2.0" in r.err


def test_the_cores_own_refusal_of_a_2_0_client_is_exit_2_naming_both_versions(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    """The 412 body a 3.0 core sends for a 2.0 header, as the contract fixture has it."""
    core.respond("GET /v1/runs", 412, fixture("error", "root.incompatible-version"))
    r = run(capsys, "runs", "list")
    assert r.rc == 2
    assert "incompatible_version" in r.err
    assert "2.0" in r.err
    assert "3.0" in r.err


# --- the new shapes are accepted, not passed on unvalidated ----------------------


@pytest.mark.parametrize(
    ("name", "code", "exit_code"),
    [
        ("root.limit-reached", "limit_reached", 1),
        ("root.limit-reached-host", "limit_reached", 1),
        ("root.conflict-idempotency-key", "conflict", 1),
        ("root.unavailable-retry-shortly", "unavailable", 2),
        ("root.admission-held-heat", "admission_held", 1),
        ("root.admission-held-gateway-unknown", "admission_held", 1),
    ],
)
def test_the_new_typed_errors_map_to_their_exit_codes(name, code, exit_code) -> None:
    err = error_from_body(API["errors"][code]["http_status"], fixture("error", name))
    assert (err.error_code, err.code) == (code, exit_code)
    assert EXIT_FOR_CODE[code] == exit_code
    assert err.remediation


def test_a_limit_refusal_on_submit_is_exit_1_and_names_the_limit(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    core.respond("POST /v1/runs", 429, fixture("error", "root.limit-reached"))
    request = fixture("control-action", "submit_request.minimal")
    argv = ("runs", "submit", "--agent", request["agent_id"], "--harness", request["harness"])
    argv += ("--repo", request["repo"], "--task", request["task"])
    r = run(capsys, *argv)
    assert r.rc == 1
    assert "limit_reached" in r.err
    assert "runs_per_repository" in r.err
    j = run(capsys, *argv, "--json")
    assert j.err_json()["limit"] == fixture("error", "root.limit-reached")["error"]["limit"]


def test_a_held_submit_is_exit_1_names_the_signal_and_hints_to_wait_or_go_elsewhere(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    """t30: the shape is ready; no core route returns it until part two (planned)."""
    body = fixture("error", "root.admission-held-heat")
    core.respond("POST /v1/runs", 429, body)
    request = fixture("control-action", "submit_request.minimal")
    argv = ("runs", "submit", "--agent", request["agent_id"], "--harness", request["harness"])
    argv += ("--repo", request["repo"], "--task", request["task"])
    r = run(capsys, *argv)
    assert r.rc == 1
    assert "admission_held" in r.err
    assert "heat" in r.err
    assert "hint:" in r.err
    assert "nothing was queued" in r.err
    assert "another host" in r.err
    j = run(capsys, *argv, "--json")
    detail = j.err_json()
    assert (detail["error_code"], detail["retryable"]) == ("admission_held", True)
    assert detail["signal"] == body["error"]["signal"]
    assert len(core.seen("POST", "/v1/runs")) == 2  # one request per call: never retried


@pytest.mark.parametrize(
    "name",
    [
        "root.running-with-submitter-and-base-commit",
        "root.submitted-by-member",
        "root.waiting-for-answer",
        "root.unanswered",
    ],
)
def test_show_accepts_a_3_0_run_and_passes_the_new_fields_on(
    core, capsys: pytest.CaptureFixture[str], name
) -> None:
    payload = fixture("run", name)
    core.respond("GET /v1/runs/{id}", 200, payload)
    j = run(capsys, "runs", "show", payload["id"], "--json")
    assert j.rc == 0, j.err
    assert j.json() == payload
    assert run(capsys, "runs", "show", payload["id"]).rc == 0


def test_a_run_with_a_request_made_submitter_shape_is_an_internal_error(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    bad = cs.load_json(cs.FIXTURES / "invalid" / "run" / "root.enum-submitter-kind-caller.json")
    core.respond("GET /v1/runs/{id}", 200, bad)
    r = run(capsys, "runs", "show", bad["id"])
    assert r.rc == 2
    assert "the core sent an invalid run payload" in r.err
    assert run(capsys, "runs", "show", bad["id"], "--json").err_json()["error_code"] == "internal"


def test_attach_ends_on_the_unanswered_terminal_state(core, capsys) -> None:
    events = cs.read_stream(cs.FIXTURES / "streams" / "valid" / "question-unanswered.jsonl")
    core.events = events
    assert "unanswered" in _stream._TERMINAL_STATES
    j = run(capsys, "runs", "attach", events[0]["run_id"], "--json")
    assert j.rc == 0, j.err
    assert len(j.out.splitlines()) == len(events)
    assert all(_contract.problem("event", e) is None for e in events)


def test_list_can_filter_on_the_unanswered_state(core, capsys) -> None:
    assert run(capsys, "runs", "list", "--state", "unanswered").rc == 0
    assert core.seen("GET", "/v1/runs")[0]["query"] == {"state": "unanswered"}
