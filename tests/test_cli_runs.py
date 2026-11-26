"""``agents runs ...`` against the fake core: every verb, text and ``--json``."""

from __future__ import annotations

import json

import pytest

from tests.cli_support import assert_valid, run
from tests.fake_core import RUN_ID, fixture, stream_events

SUBMIT = [
    "runs", "submit", "--agent", "thor-culture-agents", "--harness", "claude-code",
    "--repo", "/srv/repos/demo", "--task", "Add a unit test for the parser's empty-input case.",
]  # fmt: skip


# --- submit ------------------------------------------------------------------


def test_submit_text_and_request_matches_the_contract(
    core, capsys: pytest.CaptureFixture[str]
) -> None:
    r = run(capsys, *SUBMIT)
    assert r.rc == 0
    assert r.out.splitlines()[0] == f"submitted {RUN_ID} (queued)"
    assert r.out.splitlines()[1].startswith("idempotency key: cli-")
    sent = core.seen("POST", "/v1/runs")[0]
    assert_valid("control-action.json#/$defs/submit_request", sent["body"])
    key = sent["body"].pop("idempotency_key")  # the CLI generates one when the user gives none
    assert key.startswith("cli-")
    assert sent["body"] == fixture("control-action", "submit_request.minimal")
    assert sent["version_header"] == "3.0"


def test_submit_json_with_every_optional_field(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(
        capsys, *SUBMIT, "--deadline", "2026-11-25T11:00:00Z", "--idempotency-key", "ticket-1234",
        "--caller", "thor-planner", "--caller-kind", "agent", "--json",
    )  # fmt: skip
    assert r.rc == 0
    assert r.json() == {
        **fixture("control-action", "submit_response.queued"),
        "idempotency_key": "ticket-1234",
    }
    body = core.seen("POST", "/v1/runs")[0]["body"]
    assert_valid("control-action.json#/$defs/submit_request", body)
    assert body["caller"] == {"kind": "agent", "id": "thor-planner"}
    assert body["deadline"] == "2026-11-25T11:00:00Z"
    assert body["idempotency_key"] == "ticket-1234"


def test_submit_normalises_a_relative_repo(core, capsys, tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    args = [a if a != "/srv/repos/demo" else "./sub/../repo" for a in SUBMIT]
    assert run(capsys, *args).rc == 0
    assert core.seen("POST", "/v1/runs")[0]["body"]["repo"] == str(tmp_path / "repo")


def test_submit_session_and_delegate_are_sent_and_the_refusal_surfaces(core, capsys) -> None:
    core.respond("POST /v1/runs", 422, fixture("error", "root.unsupported"))
    r = run(capsys, *SUBMIT, "--session-id", "thor-culture-agents.ses.01JDQ5V7M2K8X9Y0Z1A2B3C4D5")
    assert r.rc == 1
    body = core.seen("POST", "/v1/runs")[0]["body"]
    assert_valid("control-action.json#/$defs/submit_request", body)
    assert body["session_id"].endswith("4D5")
    assert "unsupported" in r.err


def test_submit_requires_its_flags(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "runs", "submit", "--agent", "thor-culture-agents")
    assert r.rc == 1
    assert "hint:" in r.err
    assert core.requests == []


# --- read verbs --------------------------------------------------------------


def test_list_text_json_and_query(core, capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "list")
    assert text.rc == 0
    assert f"{RUN_ID}  succeeded  claude-code  /srv/repos/demo" in text.out
    j = run(capsys, "runs", "list", "--state", "running", "--agent", "thor-reviewer",
            "--limit", "5", "--json")  # fmt: skip
    assert j.json() == fixture("run", "run_list.two-runs")
    query = core.seen("GET", "/v1/runs")[-1]["query"]
    assert query == {"state": "running", "agent_id": "thor-reviewer", "limit": "5"}


def test_list_empty(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/runs", 200, fixture("run", "run_list.empty"))
    assert run(capsys, "runs", "list").out.strip() == "no runs"


def test_list_rejects_an_unknown_state(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "runs", "list", "--state", "paused")
    assert r.rc == 1
    assert core.requests == []


def test_show(core, capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "show", RUN_ID)
    assert text.rc == 0
    assert "state: running" in text.out
    assert "live control: true" in text.out
    assert "owner: operator thor-operator" in text.out
    j = run(capsys, "runs", "show", RUN_ID, "--json")
    assert j.json() == fixture("run", "root.running")


def test_logs(core, capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "logs", RUN_ID, "--after", "0", "--limit", "2")
    assert text.rc == 0
    assert "#2 2026-11-25T10:00:02Z run.state queued -> running" in text.out
    assert "more events follow: last cursor is 6" in text.out
    assert core.seen("GET", f"/v1/runs/{RUN_ID}/events")[0]["query"] == {"after": "0", "limit": "2"}
    j = run(capsys, "runs", "logs", RUN_ID, "--json")
    assert j.json() == fixture("event", "event_page.first-page")


def test_result(core, capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "result", RUN_ID)
    assert text.rc == 0
    assert "state: succeeded" in text.out
    j = run(capsys, "runs", "result", RUN_ID, "--json")
    assert j.json() == fixture("run", "run_result.succeeded")


def test_result_on_an_active_run_is_a_retryable_conflict(core, capsys) -> None:
    core.respond("GET /v1/runs/{id}/result", 409, fixture("error", "root.conflict"))
    r = run(capsys, "runs", "result", RUN_ID, "--json")
    assert r.rc == 1
    err = r.err_json()
    assert err["error_code"] == "conflict"
    assert err["code"] == 1


def test_failed_result_shows_the_error(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/runs/{id}/result", 200, fixture("run", "run_result.failed"))
    out = run(capsys, "runs", "result", RUN_ID).out
    assert "state: failed" in out
    assert "error: internal: harness exited with status 1" in out


# --- control verbs -----------------------------------------------------------


def test_steer(core, capsys: pytest.CaptureFixture[str]) -> None:
    msg = "Stop writing files; write STEERED.txt."
    text = run(capsys, "runs", "steer", RUN_ID, msg)
    assert text.rc == 0
    assert text.out.startswith(f"steer accepted for {RUN_ID}")
    body = core.seen("POST", f"/v1/runs/{RUN_ID}/steer")[0]["body"]
    assert_valid("control-action.json#/$defs/steer_request", body)
    assert body.pop("idempotency_key").startswith("cli-")  # generated when none is given
    assert body == fixture("control-action", "steer_request.minimal")
    j = run(capsys, "runs", "steer", RUN_ID, msg, "--json").json()
    assert j.pop("idempotency_key").startswith("cli-")
    assert j == fixture("control-action", "accepted_response.steer")


def test_steer_refused_as_unsupported_keeps_the_typed_error(core, capsys) -> None:
    core.respond("POST /v1/runs/{id}/steer", 422, fixture("error", "root.unsupported"))
    text = run(capsys, "runs", "steer", RUN_ID, "hello")
    assert text.rc == 1
    assert text.out == ""
    assert "error: unsupported: harness opencode cannot steer a running turn" in text.err
    assert "hint:" in text.err
    j = run(capsys, "runs", "steer", RUN_ID, "hello", "--json")
    assert j.rc == 1
    err = j.err_json()
    assert (err["error_code"], err["capability"]) == ("unsupported", "steer")
    assert {"code", "message", "remediation"} <= set(err)


def test_steer_after_core_restart_names_reconnect(core, capsys) -> None:
    core.respond("POST /v1/runs/{id}/steer", 422, fixture("error", "root.reconnect-unsupported"))
    r = run(capsys, "runs", "steer", RUN_ID, "hello", "--json")
    assert r.rc == 1
    assert r.err_json()["capability"] == "reconnect"


def test_cancel(core, capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "cancel", RUN_ID, "--reason", "wrong repository",
               "--idempotency-key", "cancel-1")  # fmt: skip
    assert text.rc == 0
    assert text.out.startswith(f"cancel accepted for {RUN_ID}")
    body = core.seen("POST", f"/v1/runs/{RUN_ID}/cancel")[0]["body"]
    assert_valid("control-action.json#/$defs/cancel_request", body)
    assert body == fixture("control-action", "cancel_request.with-reason-and-key")
    j = run(capsys, "runs", "cancel", RUN_ID, "--json").json()
    assert j.pop("idempotency_key").startswith("cli-")
    assert j == fixture("control-action", "accepted_response.cancel")
    assert_valid(
        "control-action.json#/$defs/cancel_request",
        core.seen("POST", f"/v1/runs/{RUN_ID}/cancel")[-1]["body"],
    )


def test_limit_reached_and_denied_are_user_errors(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("POST /v1/runs", 429, fixture("error", "root.limit-reached"))
    limited = run(capsys, *SUBMIT, "--json")
    assert limited.rc == 1
    assert limited.err_json()["error_code"] == "limit_reached"
    assert limited.err_json()["limit"] == {
        "name": "runs_per_repository",
        "value": 2,
        "active": 2,
        "repo": "/srv/repos/demo",
    }
    assert "nothing was queued" in limited.err_json()["remediation"]
    core.respond("POST /v1/runs", 403, fixture("error", "root.denied"))
    assert run(capsys, *SUBMIT).rc == 1


# --- attach ------------------------------------------------------------------


def test_attach_text_replays_to_the_terminal_state(core, capsys) -> None:
    r = run(capsys, "runs", "attach", RUN_ID)
    assert r.rc == 0
    lines = r.out.splitlines()
    assert len(lines) == len(stream_events())
    assert lines[0].startswith("#1 ")
    assert "null" not in lines[0]
    assert "run.output text:" in r.out
    assert lines[-1].endswith("running -> succeeded")
    assert core.seen("GET", f"/v1/runs/{RUN_ID}/attach")[0]["query"] == {"after": "0"}


def test_attach_json_is_one_event_per_line(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "runs", "attach", RUN_ID, "--after", "3", "--json")
    assert r.rc == 0
    events = [json.loads(line) for line in r.out.splitlines()]
    assert events == [e for e in stream_events() if e["cursor"] > 3]
    assert core.seen("GET", f"/v1/runs/{RUN_ID}/attach")[0]["query"] == {"after": "3"}


def test_attach_reconnects_from_the_last_cursor_without_gap_or_duplicate(core, capsys) -> None:
    core.attach_cutoffs = [2, 1]  # the stream breaks twice before the terminal event
    r = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert r.rc == 0
    cursors = [json.loads(line)["cursor"] for line in r.out.splitlines()]
    assert cursors == [e["cursor"] for e in stream_events()]
    afters = [q["query"]["after"] for q in core.seen("GET", f"/v1/runs/{RUN_ID}/attach")]
    assert afters == ["0", "2", "3"]


def test_attach_to_a_finished_run_with_nothing_new_returns(core, capsys) -> None:
    final = stream_events()[-1]["cursor"]
    core.respond("GET /v1/runs/{id}", 200, {**fixture("run", "root.succeeded"), "cursor": final})
    core.events = []  # the core closes at once with no events
    r = run(capsys, "runs", "attach", RUN_ID, "--after", str(final))
    assert r.rc == 0
    assert r.out == ""


def test_attach_unknown_run(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("attach", 404, fixture("error", "root.not-found"))
    r = run(capsys, "runs", "attach", RUN_ID)
    assert r.rc == 1
    assert "not_found" in r.err


# --- the core is not there ---------------------------------------------------

VERBS = [
    SUBMIT,
    ["runs", "list"],
    ["runs", "show", RUN_ID],
    ["runs", "attach", RUN_ID],
    ["runs", "steer", RUN_ID, "hi"],
    ["runs", "cancel", RUN_ID],
    ["runs", "logs", RUN_ID],
    ["runs", "result", RUN_ID],
]


@pytest.mark.parametrize("verb", VERBS, ids=[v[1] for v in VERBS])
@pytest.mark.parametrize("flags", [[], ["--json"]], ids=["text", "json"])
def test_stopped_core_exits_2_with_a_hint_and_no_traceback(no_core, capsys, verb, flags) -> None:
    r = run(capsys, *verb, *flags)
    assert r.rc == 2
    assert r.out == ""
    assert "Traceback" not in r.err
    if flags:
        err = r.err_json()
        assert err["code"] == 2
        assert err["error_code"] == "unavailable"
        assert "start the core" in err["remediation"]
    else:
        assert r.err.startswith("error: cannot reach the core")
        assert "\nhint: start the core" in r.err


def test_refused_connection_is_the_same(tmp_path, monkeypatch, capsys) -> None:
    import socket

    path = tmp_path / "stale.sock"
    sock = socket.socket(socket.AF_UNIX)
    sock.bind(str(path))  # bound but never listening: connect is refused
    sock.close()
    monkeypatch.setenv("CULTURE_AGENTS_SOCKET", str(path))
    r = run(capsys, "runs", "list")
    assert r.rc == 2
    assert "hint:" in r.err


# --- incompatible core -------------------------------------------------------


@pytest.mark.parametrize("server", ["4.0", "2.9"])
def test_incompatible_core_is_refused_naming_both_versions(core, capsys, server) -> None:
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "api_version": server}
    )
    r = run(capsys, "runs", "list")
    assert r.rc == 2
    assert r.out == ""
    assert "this client speaks 3.0" in r.err
    assert f"the core speaks {server}" in r.err
    assert [q["path"] for q in core.requests] == ["/v1/version"]  # never reached the route
    j = run(capsys, "runs", "list", "--json")
    assert j.rc == 2
    detail = j.err_json()
    assert (detail["client_api_version"], detail["server_api_version"]) == ("3.0", server)


def test_older_minor_is_refused_newer_minor_is_accepted(core, capsys) -> None:
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "api_version": "3.7"}
    )
    assert run(capsys, "runs", "list").rc == 0


def test_a_412_from_a_route_is_exit_2(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/runs", 412, fixture("error", "root.incompatible-version"))
    r = run(capsys, "runs", "list")
    assert r.rc == 2
    assert "incompatible_version" in r.err


def test_a_core_failure_is_exit_2(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/runs", 500, fixture("error", "root.internal"))
    assert run(capsys, "runs", "list").rc == 2
    core.respond("GET /v1/runs", 503, fixture("error", "root.unavailable"))
    assert run(capsys, "runs", "list").rc == 2


def test_an_invalid_payload_is_internal_exit_2(core, capsys: pytest.CaptureFixture[str]) -> None:
    core.respond("GET /v1/runs", 200, {"runs": [{"id": "thor-culture-agents.run.X"}]})
    r = run(capsys, "runs", "list", "--json")
    assert r.rc == 2
    assert r.err_json()["error_code"] == "internal"
    assert r.out == ""
