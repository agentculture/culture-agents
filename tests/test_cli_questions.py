"""Text mode shows a run's questions, answers, submitter, replay and warnings (escaped)."""

from __future__ import annotations

import copy

import pytest

from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture, stream_events

QID = "thor-culture-agents.qst.01JDQ5X0000000000000000001"
HOSTILE = "bad\x1b[2Jtext\nnext"


def _waiting() -> dict:
    return fixture("run", "root.waiting-for-answer")


def test_show_lists_pending_questions_base_commit_and_submitter(core, capsys) -> None:
    core.respond("GET /v1/runs/{id}", 200, _waiting())
    out = run(capsys, "runs", "show", RUN_ID).out
    assert QID in out
    assert "question" in out
    assert "Which colour should the banner use?" in out
    assert "red" in out
    assert "green" in out
    assert "2026-11-25T22:00:04Z" in out
    assert "3f786850e387550fdab836ed7e6dc881de23001b" in out
    assert "local_user" in out
    assert "operator" in out


def test_show_escapes_question_text_and_choices(core, capsys) -> None:
    doc = copy.deepcopy(_waiting())
    question = doc["pending_questions"][0]
    question["text"] = HOSTILE
    question["choices"][0]["label"] = HOSTILE
    core.respond("GET /v1/runs/{id}", 200, doc)
    out = run(capsys, "runs", "show", RUN_ID).out
    assert "\x1b" not in out
    assert "bad\\x1b[2Jtext\\nnext" in out


def test_logs_prints_question_and_answer_events(core, capsys) -> None:
    page = copy.deepcopy(fixture("event", "event_page.first-page"))
    page["events"] = [fixture("event", "root.question"), fixture("event", "root.answer")]
    core.respond("GET /v1/runs/{id}/events", 200, page)
    out = run(capsys, "runs", "logs", RUN_ID).out
    assert "run.question" in out
    assert "run.answer" in out
    assert out.count(QID) >= 2


def test_logs_escapes_answer_text(core, capsys) -> None:
    event = copy.deepcopy(fixture("event", "root.answer"))
    event["data"]["answer"] = HOSTILE
    page = copy.deepcopy(fixture("event", "event_page.first-page"))
    page["events"] = [event]
    core.respond("GET /v1/runs/{id}/events", 200, page)
    out = run(capsys, "runs", "logs", RUN_ID).out
    assert "\x1b" not in out
    assert "bad\\x1b[2Jtext\\nnext" in out


def test_attach_prints_question_and_answer_events(core, capsys) -> None:
    core.events = stream_events("question-answered")
    out = run(capsys, "runs", "attach", RUN_ID).out
    assert "run.question" in out
    assert "run.answer" in out
    assert QID in out
    assert "Which colour should the banner use?" in out


def test_submit_says_replayed(core, capsys) -> None:
    core.respond("POST /v1/runs", 200, fixture("control-action", "submit_response.replayed"))
    out = run(capsys, "runs", "submit", *_submit_args()).out
    assert "replayed" in out


def test_submit_prints_each_warning_escaped(core, capsys) -> None:
    doc = copy.deepcopy(fixture("control-action", "submit_response.with-warning"))
    doc["warnings"][0]["message"] = HOSTILE
    core.respond("POST /v1/runs", 201, doc)
    out = run(capsys, "runs", "submit", *_submit_args()).out
    assert "signal_unknown" in out
    assert "heat" in out
    assert "\x1b" not in out
    assert "bad\\x1b[2Jtext\\nnext" in out


@pytest.mark.parametrize("name", ["question-answered"])
def test_stream_fixture_exists(name: str) -> None:
    assert stream_events(name)


def _submit_args() -> list[str]:
    return [
        "--agent", "thor-culture-agents", "--harness", "claude-code",
        "--repo", "/srv/repos/demo", "--task", "x",
    ]  # fmt: skip


def test_explain_runs_does_not_call_answer_missing(capsys) -> None:
    out = run(capsys, "explain", "runs").out
    assert "`answer` is not a verb" not in out
    assert "runs answer" in out


def test_learn_names_branches_among_the_verbs_that_need_a_core(capsys) -> None:
    out = run(capsys, "learn").out
    flat = " ".join(out.split())
    assert "`agents branches`" in flat.split("exits 2")[0][-120:]
