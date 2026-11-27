"""Control-plane contract 3.0: the shapes D2 part one adds, and the D1 guarantees it keeps.

Each shape named by the D2 plan (task t3) has one valid fixture that carries
it; ``SHAPES`` maps the shape to that fixture and to the place in the payload
where the new field must be. The behaviour behind the shapes is built by later
tasks; these tests fix the shapes only.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from tests import contract_support as cs

API = cs.api_index()
SCHEMAS = cs.load_schemas()
REG = cs.registry()
README = (cs.CONTRACT / "README.md").read_text(encoding="utf-8")
GENERATED = cs.REPO_ROOT / "core" / "src" / "contract" / "generated"

#: shape -> (valid fixture, path of keys that must exist in it)
SHAPES: dict[str, tuple[str, tuple[Any, ...]]] = {
    "submitter of a local run": ("run/root.running-with-submitter-and-base-commit", ("submitter",)),
    "submitter of a remote run": ("run/root.submitted-by-member", ("submitter", "node")),
    "base commit": ("run/root.running-with-submitter-and-base-commit", ("base_commit",)),
    "idempotency conflict": ("error/root.conflict-idempotency-key", ("error", "idempotency_key")),
    "limit error": ("error/root.limit-reached", ("error", "limit", "name")),
    "question event": ("event/root.question", ("data", "question", "id")),
    "approval question event": ("event/root.question-approval", ("data", "question", "tool")),
    "answer event": ("event/root.answer", ("data", "question_id")),
    "answer request": ("control-action/answer_request.minimal", ("question_id",)),
    "answer action": ("control-action/accepted_response.answer", ("action", "kind")),
    "pending question on a run": ("run/root.waiting-for-answer", ("pending_questions", 0, "id")),
    "unanswered terminal state": ("run/root.unanswered", ("state",)),
    "unanswered result": ("run/run_result.unanswered", ("state",)),
    "retry shortly": ("error/root.unavailable-retry-shortly", ("error", "retry_after_ms")),
    "limits": ("capabilities/root.with-limits-and-admission", ("limits", "runs_per_repository")),
    "active count": ("capabilities/root.with-limits-and-admission", ("active_runs",)),
    "admission per signal": (
        "capabilities/root.with-limits-and-admission",
        ("admission", "heat", "state"),
    ),
    "no limit configured": ("capabilities/root.no-limits-signals-unknown", ("limits",)),
    "replayed submit": ("control-action/submit_response.replayed", ("replayed",)),
    "replayed action": ("control-action/accepted_response.replayed-steer", ("replayed",)),
    "admission warning": ("control-action/submit_response.with-warning", ("warnings", 0, "signal")),
}

#: Every invalid fixture a 3.0 rule needs, so that a rule cannot lose its proof unnoticed.
REFUSALS = (
    "control-action/submit_request.additionalProperties-submitter",
    "control-action/submit_request.additionalProperties-base-commit",
    "control-action/answer_request.pattern-question-id-free-string",
    "control-action/answer_request.enum-decision-maybe",
    "control-action/submit_response.const-state-running",
    "run/root.required-local-submitter-without-uid",
    "run/root.enum-submitter-kind-caller",
    "run/root.pattern-base-commit-short",
    "run/root.maxItems-pending-question-on-terminal-run",
    "error/root.required-limit-reached-without-limit",
    "error/root.enum-limit-name-unknown",
    "error/root.not-idempotency-key-on-denied",
    "error/root.const-idempotency-conflict-retryable",
    "error/root.not-retry-after-on-conflict",
    "event/root.required-question-without-answer-by",
    "event/root.const-answer-with-steer-action",
    "event/root.enum-control-with-answer-action",
    "capabilities/root.enum-signal-state-ok",
    "capabilities/root.type-hold-without-reason",
    "capabilities/root.minimum-limit-zero",
)

#: D1 guarantees the 3.0 contract keeps, each with the fixture that proves the refusal.
_ERR = "invalid/error/root."
D1_GUARANTEES = {
    "unsupported names the capability": _ERR + "required-unsupported-without-capability.json",
    "unsupported capability is a known name": _ERR + "enum-unsupported-unknown-capability.json",
    "the cursor has no gap": "streams/invalid/cursor-gap.jsonl",
    "the cursor starts at one": "streams/invalid/cursor-not-starting-at-one.jsonl",
    "the cursor belongs to one run": "streams/invalid/mixed-run-ids.jsonl",
    "a terminal state is final": "streams/invalid/event-after-terminal.jsonl",
    "unknown is never success": "streams/invalid/illegal-transition-unknown-to-succeeded.jsonl",
    "a terminal run has no live control": (
        "invalid/run/root.const-live-control-on-terminal-run.json"
    ),
}


def _fixture(name: str, kind: str = "valid") -> Path:
    return cs.FIXTURES / kind / f"{name}.json"


def _dig(value: Any, path: tuple[Any, ...]) -> Any:
    for key in path:
        value = value[key]
    return value


# --- the version --------------------------------------------------------------


def test_the_contract_is_version_3_1():
    # 3.0 plus one MINOR addition, the fleet member list (t22); every 3.0 shape is unchanged.
    assert API["api_version"] == "3.1"
    assert cs.load_json(_fixture("version/root.current"))["api_version"] == "3.1"
    assert "3.1" in SCHEMAS["version.json"]["description"]
    assert "API version **3.1**" in README


def test_the_incompatible_version_fixture_is_a_2_0_client_against_this_core():
    error = cs.load_json(_fixture("error/root.incompatible-version"))["error"]
    assert (error["client_api_version"], error["server_api_version"]) == ("2.0", "3.0")
    assert "2.0" in error["message"]
    assert "3.0" in error["message"]
    assert API["errors"]["incompatible_version"]["exit_code"] == 2


# --- one fixture per new shape ------------------------------------------------


@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_each_new_shape_has_a_valid_fixture_that_carries_it(shape):
    name, path = SHAPES[shape]
    payload = cs.load_json(_fixture(name))
    validator = cs.validator_for(cs.fixture_target(_fixture(name)), REG)
    errors = [e.message for e in validator.iter_errors(payload)]
    assert errors == []
    assert _dig(payload, path) is not None


@pytest.mark.parametrize("name", REFUSALS)
def test_each_new_rule_has_an_invalid_fixture(name):
    path = _fixture(name, "invalid")
    assert path.is_file(), name
    assert list(cs.validator_for(cs.fixture_target(path), REG).iter_errors(cs.load_json(path)))


def test_the_submitter_is_never_a_request_field():
    """c35: no request schema has a property that could set or change the submitter."""
    for name, node in SCHEMAS["control-action.json"]["$defs"].items():
        if name.endswith("_request"):
            assert "submitter" not in node["properties"], name
            assert "base_commit" not in node["properties"], name
            assert node["additionalProperties"] is False, name


def test_submitter_and_base_commit_are_optional_until_their_tasks_fill_them():
    run = SCHEMAS["run.json"]
    for field in ("submitter", "base_commit", "pending_questions"):
        assert field in run["properties"], field
        assert field not in run["required"], field


def test_the_local_and_the_member_submitter_are_told_apart():
    local = cs.load_json(_fixture("run/root.running-with-submitter-and-base-commit"))["submitter"]
    member = cs.load_json(_fixture("run/root.submitted-by-member"))["submitter"]
    assert (local["kind"], member["kind"]) == ("local_user", "member")
    assert "uid" in local
    assert "node" not in local
    assert member["node"] == "thor"
    assert "uid" not in member


# --- errors -------------------------------------------------------------------


def test_the_limit_error_names_the_limit_and_its_value():
    error = cs.load_json(_fixture("error/root.limit-reached"))["error"]
    names = SCHEMAS["capabilities.json"]["$defs"]["limit_name"]["enum"]
    assert error["code"] == "limit_reached"
    assert error["limit"]["name"] in names
    assert error["limit"]["value"] >= 1
    assert set(names) == set(SCHEMAS["capabilities.json"]["$defs"]["limits"]["required"])
    row = API["errors"]["limit_reached"]
    assert (row["exit_code"], row["retryable"]) == (1, True)
    assert "limit_reached" in next(r for r in API["routes"] if r["id"] == "runs.submit")["errors"]


def test_an_idempotency_conflict_is_a_conflict_that_names_the_key_and_is_not_retryable():
    error = cs.load_json(_fixture("error/root.conflict-idempotency-key"))["error"]
    assert (error["code"], error["retryable"]) == ("conflict", False)
    assert error["idempotency_key"]
    assert error["run_id"]
    assert "conflict" in next(r for r in API["routes"] if r["id"] == "runs.submit")["errors"]


def test_retry_shortly_is_an_unavailable_error_with_a_wait():
    error = cs.load_json(_fixture("error/root.unavailable-retry-shortly"))["error"]
    assert (error["code"], error["retryable"]) == ("unavailable", True)
    assert error["retry_after_ms"] >= 0
    assert error["run_id"]


def test_the_busy_refusal_is_gone_now_that_concurrent_runs_are_built():
    assert "busy" not in API["errors"]
    assert "busy" not in SCHEMAS["error.json"]["$defs"]["code"]["enum"]
    props = SCHEMAS["error.json"]["$defs"]["error"]["properties"]
    assert "active_run_id" not in props
    assert "repo" not in props
    assert all("busy" not in route["errors"] for route in API["routes"])
    assert re.search(r"`busy` is removed[^\n]*\bt8\b", README), "README must say t8 removed busy"
    assert "limit_reached" in next(r for r in API["routes"] if r["id"] == "runs.submit")["errors"]


# --- questions and answers ----------------------------------------------------


def test_question_and_answer_are_event_kinds_and_answer_is_a_route():
    kinds = SCHEMAS["event.json"]["$defs"]["kind"]["enum"]
    assert {"run.question", "run.answer"} <= set(kinds)
    route = next(r for r in API["routes"] if r["id"] == "runs.answer")
    assert route["request"] == "control-action.json#/$defs/answer_request"
    assert {"conflict", "unsupported", "not_found", "unavailable"} <= set(route["errors"])


def test_a_question_carries_its_own_time_limit_and_the_answer_names_the_question():
    question = cs.load_json(_fixture("event/root.question"))["data"]["question"]
    answer = cs.load_json(_fixture("event/root.answer"))["data"]
    assert question["answer_by"]
    assert question["kind"] == "question"
    assert answer["question_id"] == question["id"]
    assert (answer["action"]["kind"], answer["action"]["outcome"]) == ("answer", "accepted")
    agent = cs.load_json(_fixture("event/root.question"))["run_id"].split(".run.")[0]
    assert question["id"].startswith(agent + ".qst.")


def test_unanswered_is_terminal_and_reached_only_through_cancelling():
    machine = API["state_machine"]
    assert "unanswered" in machine["terminal"]
    assert machine["transitions"]["unanswered"] == []
    sources = {s for s, targets in machine["transitions"].items() if "unanswered" in targets}
    assert sources == {"cancelling"}
    assert "unanswered" in SCHEMAS["run.json"]["$defs"]["terminal_state"]["enum"]


def test_the_question_streams_end_answered_and_unanswered():
    ends = {}
    for name in ("question-answered", "question-unanswered"):
        events = cs.read_stream(cs.FIXTURES / "streams" / "valid" / f"{name}.jsonl")
        assert cs.stream_problems(events, API, REG) == []
        assert "run.question" in {e["kind"] for e in events}
        ends[name] = events[-1]["data"]["to"]
    assert ends == {"question-answered": "succeeded", "question-unanswered": "unanswered"}


@pytest.mark.parametrize(
    "name",
    [
        "answer-without-question",
        "second-answer-to-one-question",
        "illegal-transition-running-to-unanswered",
    ],
)
def test_a_stream_that_breaks_a_question_rule_is_caught(name):
    events = cs.read_stream(cs.FIXTURES / "streams" / "invalid" / f"{name}.jsonl")
    assert cs.stream_problems(events, API, REG)


# --- the capability report ----------------------------------------------------


def test_capabilities_that_d2_part_one_builds_are_no_longer_pinned_to_unsupported():
    props = SCHEMAS["capabilities.json"]["$defs"]["capability_set"]["properties"]
    for name in ("answer", "reconnect", "worktree_isolation", "placement"):
        assert props[name]["$ref"].endswith("#/$defs/capability"), name
    for name in ("pause", "resume", "continue_session", "delegate"):
        assert props[name]["$ref"].endswith("#/$defs/deferred"), name


def test_the_report_states_limits_active_runs_and_admission_per_signal():
    doc = cs.load_json(_fixture("capabilities/root.with-limits-and-admission"))
    bare = cs.load_json(_fixture("capabilities/root.no-limits-signals-unknown"))
    signals = SCHEMAS["capabilities.json"]["$defs"]["signal_name"]["enum"]
    states = SCHEMAS["capabilities.json"]["$defs"]["signal_state"]["enum"]
    assert set(states) == {"admit", "hold", "unknown"}
    assert set(doc["admission"]) == set(signals) == set(bare["admission"])
    assert doc["active_runs"] >= 0
    assert bare["limits"] == {"runs_per_repository": None, "runs_per_host": None}
    assert {s["state"] for s in bare["admission"].values()} == {"unknown"}
    assert all(s["reason"] for s in bare["admission"].values())


# --- the record of what changed -----------------------------------------------


@pytest.mark.parametrize(
    "token",
    [
        "`submitter`",
        "`base_commit`",
        "`pending_questions`",
        "`limit_reached`",
        "`idempotency_key`",
        "`retry_after_ms`",
        "`run.question`",
        "`run.answer`",
        "`unanswered`",
        "`answer_request`",
        "`question_id`",
        "`limits`",
        "`active_runs`",
        "`admission`",
        "`replayed`",
        "`warnings`",
        "`answer`",
        "`reconnect`",
        "`worktree_isolation`",
        "`busy`",
    ],
)
def test_readme_lists_every_breaking_change_from_2_0(token):
    start = README.index("## Changes from 2.0")
    end = README.index("\n## ", start + 1)
    assert token in README[start:end], token


def test_readme_says_part_two_shapes_come_as_minor_additions():
    start = README.index("## Changes from 2.0")
    section = README[start : README.index("\n## ", start + 1)]
    assert "3.x" in section
    assert "MINOR" in section
    for word in ("members", "unreachable", "bundle"):
        assert word in section, word


# --- guarantees kept from D1 --------------------------------------------------


@pytest.mark.parametrize("guarantee", sorted(D1_GUARANTEES))
def test_a_d1_guarantee_keeps_its_fixture(guarantee):
    path = cs.FIXTURES / D1_GUARANTEES[guarantee]
    assert path.is_file(), guarantee
    if path.suffix == ".jsonl":
        assert cs.stream_problems(cs.read_stream(path), API, REG), guarantee
    else:
        validator = cs.validator_for(cs.fixture_target(path), REG)
        assert list(validator.iter_errors(cs.load_json(path))), guarantee


def test_unknown_and_unanswered_never_lead_to_another_state():
    machine = API["state_machine"]
    for state in machine["terminal"]:
        assert machine["transitions"][state] == [], state
    for state, targets in machine["transitions"].items():
        if "succeeded" in targets:
            assert state in machine["active"], state


def test_an_unsupported_error_must_name_a_capability_in_3_0():
    validator = cs.validator_for("error.json", REG)
    body = {"error": {"code": "unsupported", "message": "no", "retryable": False}}
    assert list(validator.iter_errors(body))
    body["error"]["capability"] = "answer"
    assert list(validator.iter_errors(body)) == []


@pytest.mark.parametrize("path", sorted(GENERATED.glob("*.ts")), ids=lambda p: p.name)
def test_no_vendor_or_ai_sdk_name_in_the_generated_types(path):
    assert cs.denied_names(path.read_text(encoding="utf-8")) == []


def test_the_generated_types_cover_the_new_shapes():
    text = "\n".join(p.read_text(encoding="utf-8") for p in GENERATED.glob("*.ts"))
    for name in ("Submitter", "Question", "QuestionData", "AnswerData", "Limits", "Admission"):
        assert re.search(rf"export type {name} =", text), name
    assert '"unanswered"' in text
    assert '"limit_reached"' in text
