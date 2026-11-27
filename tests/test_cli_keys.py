"""Idempotency keys, retry after a timeout and the answer verb, against the fake core (t16)."""

from __future__ import annotations

import pytest

from tests.cli_support import assert_valid, run
from tests.fake_core import RUN_ID, fixture
from tests.test_cli_runs import SUBMIT

# --- idempotency keys and retry (t16) ------------------------------------------------------


def test_every_keyed_verb_sends_a_generated_key_and_prints_it(core, capsys) -> None:
    sent = {}
    for args, route in (
        (SUBMIT, "/v1/runs"),
        (["runs", "steer", RUN_ID, "go on"], f"/v1/runs/{RUN_ID}/steer"),
        (["runs", "cancel", RUN_ID], f"/v1/runs/{RUN_ID}/cancel"),
    ):
        r = run(capsys, *args, "--json")
        assert r.rc == 0
        key = r.json()["idempotency_key"]
        body = core.seen("POST", route)[0]["body"]
        assert body["idempotency_key"] == key
        assert key.startswith("cli-")
        sent[route] = key
    assert len(set(sent.values())) == 3
    text = run(capsys, "runs", "cancel", RUN_ID)
    assert "idempotency key: cli-" in text.out


def test_a_given_key_is_used_unchanged(core, capsys) -> None:
    r = run(capsys, "runs", "steer", RUN_ID, "hi", "--idempotency-key", "mine-1", "--json")
    assert r.json()["idempotency_key"] == "mine-1"
    assert core.seen("POST", f"/v1/runs/{RUN_ID}/steer")[0]["body"]["idempotency_key"] == "mine-1"
    assert (
        "idempotency key" not in run(capsys, "runs", "cancel", RUN_ID, "--idempotency-key", "k").out
    )


@pytest.mark.parametrize("verb", ["submit", "steer", "cancel"])
def test_after_a_timeout_the_cli_retries_with_the_same_key_and_one_run_results(
    core, capsys, monkeypatch, verb
) -> None:
    from culture_agents.cli import _client

    monkeypatch.setattr(_client, "DEFAULT_TIMEOUT", 0.3)
    monkeypatch.setattr(_client, "KEYED_PAUSE", 0.0)
    args, route = {
        "submit": (SUBMIT, "/v1/runs"),
        "steer": (["runs", "steer", RUN_ID, "x"], f"/v1/runs/{RUN_ID}/steer"),
        "cancel": (["runs", "cancel", RUN_ID], f"/v1/runs/{RUN_ID}/cancel"),
    }[verb]
    core.post_stalls = [0.8]  # the first request takes effect but its answer comes too late
    r = run(capsys, *args, "--json")
    assert r.rc == 0
    posts = core.seen("POST", route)
    assert len(posts) == 2
    assert posts[0]["body"] == posts[1]["body"]
    assert core.effects(route) == 1  # a core that honours keys made exactly 1 run / action
    assert r.json()["idempotency_key"] == posts[0]["body"]["idempotency_key"]


def test_retries_stop_and_the_error_names_the_key(core, capsys, monkeypatch) -> None:
    from culture_agents.cli import _client

    monkeypatch.setattr(_client, "DEFAULT_TIMEOUT", 0.2)
    monkeypatch.setattr(_client, "KEYED_PAUSE", 0.0)
    core.post_stalls = [0.5] * 3
    r = run(capsys, *SUBMIT, "--idempotency-key", "k-1", "--json")
    assert r.rc == 2
    err = r.err_json()
    assert err["error_code"] == "unavailable"
    assert "--idempotency-key k-1" in err["remediation"]
    assert len(core.seen("POST", "/v1/runs")) == 3


def test_a_typed_refusal_is_not_retried(core, capsys) -> None:
    core.respond("POST /v1/runs", 409, fixture("error", "root.conflict"))
    assert run(capsys, *SUBMIT).rc == 1
    assert len(core.seen("POST", "/v1/runs")) == 1


def test_an_invalid_core_response_is_internal_exit_2(core, capsys) -> None:
    for key, args in (
        ("POST /v1/runs", SUBMIT),
        ("POST /v1/runs/{id}/steer", ["runs", "steer", RUN_ID, "x"]),
        ("POST /v1/runs/{id}/cancel", ["runs", "cancel", RUN_ID]),
        ("POST /v1/runs/{id}/answer", ANSWER),
    ):
        core.respond(key, 202 if "{id}" in key else 201, {"nonsense": True})
        r = run(capsys, *args, "--json")
        assert r.rc == 2
        assert r.err_json()["error_code"] == "internal"


# --- answer ---------------------------------------------------------------------------------

QID = "thor-culture-agents.qst.01JDQ5X0000000000000000001"
ANSWER = ["runs", "answer", RUN_ID, "--question", QID, "--choice", "green"]


def test_answer_delivers_and_matches_the_contract(core, capsys) -> None:
    r = run(capsys, *ANSWER, "--idempotency-key", "answer-1", "--json")
    assert r.rc == 0
    assert r.json()["action"] == fixture("control-action", "accepted_response.answer")["action"]
    body = core.seen("POST", f"/v1/runs/{RUN_ID}/answer")[0]["body"]
    assert_valid("control-action.json#/$defs/answer_request", body)
    assert body == fixture("control-action", "answer_request.choice")
    text = run(capsys, "runs", "answer", RUN_ID, "--question", QID, "--decision", "deny",
               "--answer", "too risky")  # fmt: skip
    assert text.rc == 0
    assert text.out.startswith(f"answer accepted for {RUN_ID}")
    sent = core.seen("POST", f"/v1/runs/{RUN_ID}/answer")[1]["body"]
    assert_valid("control-action.json#/$defs/answer_request", sent)
    assert "idempotency_key" not in sent


def test_answer_needs_something_to_say(core, capsys) -> None:
    r = run(capsys, "runs", "answer", RUN_ID, "--question", QID)
    assert r.rc == 1
    assert not core.seen("POST", f"/v1/runs/{RUN_ID}/answer")


@pytest.mark.parametrize(
    ("status", "name", "code", "word"),
    [(409, "root.conflict", "conflict", "never retried"),
     (422, "root.unsupported", "unsupported", "cannot ask")],
)  # fmt: skip
def test_answer_typed_errors_in_text_and_json_and_never_retried(
    core, capsys, status, name, code, word
) -> None:
    core.respond("POST /v1/runs/{id}/answer", status, fixture("error", name))
    text = run(capsys, *ANSWER)
    assert text.rc == 1
    assert code in text.err
    assert word in text.err
    j = run(capsys, *ANSWER, "--json")
    assert j.rc == 1
    assert j.err_json()["error_code"] == code
    assert len(core.seen("POST", f"/v1/runs/{RUN_ID}/answer")) == 2  # one send per invocation


def test_answer_is_not_retried_after_a_timeout(core, capsys, monkeypatch) -> None:
    from culture_agents.cli import _client

    monkeypatch.setattr(_client, "DEFAULT_TIMEOUT", 0.2)
    core.post_stalls = [0.5]
    r = run(capsys, *ANSWER)
    assert r.rc == 2
    assert len(core.seen("POST", f"/v1/runs/{RUN_ID}/answer")) == 1
