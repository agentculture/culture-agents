"""``agents agents list|status`` against the fake core."""

from __future__ import annotations

import pytest

from tests.cli_support import run
from tests.fake_core import AGENT_ID, fixture


def test_list_text(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "agents", "list")
    assert r.rc == 0
    assert "node: thor" in r.out
    assert AGENT_ID in r.out
    assert "thor-reviewer" in r.out
    # honest capability reporting: the unsupported ones are named with a reason
    assert "steer: UNSUPPORTED - the session protocol has no in-turn user message" in r.out
    assert r.err == ""


def test_list_json_is_the_contract_payload(core, capsys: pytest.CaptureFixture[str]) -> None:
    # The agent list as the core sends it, plus the member list under ``fleet`` (API 3.1, t22).
    r = run(capsys, "agents", "list", "--json")
    assert r.rc == 0
    expected = fixture("agent", "agent_list.two-agents")
    expected["fleet"] = fixture("fleet", "root.one-member-one-refusal")
    assert r.json() == expected
    assert core.seen("GET", "/v1/agents")[0]["version_header"] == "3.3"
    assert core.seen("GET", "/v1/fleet/members")[0]["version_header"] == "3.3"


def test_status_text(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "agents", "status", AGENT_ID)
    assert r.rc == 0
    assert f"{AGENT_ID}  running" in r.out
    assert "harness opencode" in r.out
    assert "UNSUPPORTED" in r.out
    # one agent call plus one capability call per harness the agent lists
    assert len(core.seen("GET", f"/v1/agents/{AGENT_ID}")) == 1
    assert len(core.seen("GET", "/v1/harnesses/claude-code")) == 1
    assert len(core.seen("GET", "/v1/harnesses/opencode")) == 1


def test_status_json(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "agents", "status", AGENT_ID, "--json")
    assert r.rc == 0
    payload = r.json()
    assert payload["agent"]["id"] == AGENT_ID
    assert [h["harness"] for h in payload["harnesses"]] == ["claude-code", "opencode"]


def test_status_unknown_agent_is_a_user_error(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/agents/{id}", 404, fixture("error", "root.not-found"))
    r = run(capsys, "agents", "status", "thor-nobody")
    assert r.rc == 1
    assert r.err.startswith("error: not_found:")
    assert "hint:" in r.err


def test_status_requires_an_agent_id(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "agents", "status")
    assert r.rc == 1
    assert "hint:" in r.err
    assert core.requests == []


@pytest.mark.parametrize("verb", [["list"], ["status", AGENT_ID]])
def test_stopped_core_exits_2_with_a_hint(no_core, capsys, verb) -> None:
    r = run(capsys, "agents", *verb)
    assert r.rc == 2
    assert r.out == ""
    assert "error: cannot reach the core" in r.err
    assert "hint:" in r.err
    assert "Traceback" not in r.err


def test_status_reports_limits_active_runs_and_admission_in_text_and_json(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = fixture("capabilities", "root.with-limits-and-admission")
    core.overrides["GET /v1/harnesses/{id}"] = (200, doc)
    text = run(capsys, "agents", "status", AGENT_ID)
    assert text.rc == 0
    assert "limit runs_per_repository: 2" in text.out
    assert "limit runs_per_host: none set" in text.out
    assert f"active runs: {doc['active_runs']}" in text.out
    assert f"admission heat: {doc['admission']['heat']['state']}" in text.out
    assert "admission gateway: unknown (not consulted)" in text.out
    as_json = run(capsys, "agents", "status", AGENT_ID, "--json")
    assert as_json.rc == 0
    for harness in as_json.json()["harnesses"]:
        assert harness["limits"] == doc["limits"]
        assert harness["active_runs"] == doc["active_runs"]
        assert harness["admission"] == doc["admission"]


def test_status_states_unknown_signals_and_no_limits(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    doc = fixture("capabilities", "root.no-limits-signals-unknown")
    core.overrides["GET /v1/harnesses/{id}"] = (200, doc)
    r = run(capsys, "agents", "status", AGENT_ID)
    assert "limit runs_per_repository: none set" in r.out
    assert "admission heat: unknown - no heat state was found on this host" in r.out
