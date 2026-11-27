"""``agents runs`` on a run on another fleet member (API 3.2, t23), against the fake core.

The fake core reports node ``xxxxxxxx`` here (length-boundary filler that names
no host), so the example runs and agents of node ``thor`` are on another
member: the CLI reaches them through ``/v1/fleet/runs``. The caller chooses the
member by the node of ``--agent`` or of the run id; nothing schedules.
"""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - a fixed git invocation to make a test checkout

import pytest

from tests.cli_support import assert_valid, run
from tests.fake_core import RUN_ID, fixture

CALLER_NODE = "xxxxxxxx"
SUBMIT = [
    "runs", "submit", "--agent", "thor-culture-agents", "--harness", "claude-code",
    "--alias", "culture-agents", "--task", "Add a unit test for the parser's empty-input case.",
]  # fmt: skip


@pytest.fixture
def remote(core):
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "node": CALLER_NODE}
    )
    return core


def _checkout(path) -> str:
    git = shutil.which("git")
    assert git is not None
    env = {"GIT_CONFIG_NOSYSTEM": "1", "HOME": str(path), "PATH": "/usr/bin:/bin"}

    def call(*args: str) -> str:
        done = subprocess.run(  # nosec B603 - fixed arguments, no shell
            [git, *args], cwd=path, env=env, capture_output=True, text=True, check=True
        )
        return done.stdout.strip()

    call("init", "-q", "-b", "main")
    call(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "a",
    )
    return call("rev-parse", "HEAD")


def test_submit_by_alias_goes_to_the_fleet_route_with_the_checkout_head_as_base(
    remote, capsys, tmp_path, monkeypatch
) -> None:
    head = _checkout(tmp_path)
    monkeypatch.chdir(tmp_path)
    r = run(capsys, *SUBMIT, "--deadline-in", "3600")
    assert r.rc == 0, r.err
    lines = r.out.splitlines()
    assert lines[0] == f"submitted {RUN_ID} (queued)"
    assert lines[1] == f"base commit: {fixture('remote', 'root.queued')['base_commit']}"
    assert remote.seen("POST", "/v1/runs") == []
    sent = remote.seen("POST", "/v1/fleet/runs")[0]
    assert sent["version_header"] == "3.2"
    body = sent["body"]
    assert_valid("remote.json#/$defs/submit_request", body)
    assert body["alias"] == "culture-agents"
    assert body["deadline_ms"] == 3_600_000, "a duration, never an absolute time"
    assert "deadline" not in body
    assert "repo" not in body
    assert body["base_commit"] == head, "the HEAD of the checkout the CLI runs in (question 9)"
    assert body["caller"] == {"kind": "operator", "id": f"{CALLER_NODE}-operator"}


def test_base_can_be_named_or_left_out(remote, capsys, tmp_path, monkeypatch) -> None:
    _checkout(tmp_path)
    monkeypatch.chdir(tmp_path)
    named = "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901"
    assert run(capsys, *SUBMIT, "--base", named).rc == 0
    assert run(capsys, *SUBMIT, "--no-base").rc == 0
    bodies = [s["body"] for s in remote.seen("POST", "/v1/fleet/runs")]
    assert bodies[0]["base_commit"] == named
    assert "base_commit" not in bodies[1], "no commit: the member starts from its own HEAD"
    outside = tmp_path / "plain"
    outside.mkdir()
    monkeypatch.chdir(outside)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    assert run(capsys, *SUBMIT).rc == 0
    assert "base_commit" not in remote.seen("POST", "/v1/fleet/runs")[2]["body"]


def test_submit_json_is_the_remote_payload_and_names_the_key(remote, capsys) -> None:
    j = run(capsys, *SUBMIT, "--no-base", "--idempotency-key", "ticket-1234", "--json")
    assert j.rc == 0, j.err
    assert j.json() == {
        **fixture("remote", "submit_response.queued"),
        "idempotency_key": "ticket-1234",
    }


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        (["--repo", "/srv/repos/demo"], "give --repo"),
        (["--deadline", "2026-11-27T13:00:00Z"], "--deadline-in"),
        (["--base", "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901", "--no-base"], "not both"),
        (["--deadline-in", "0"], "1 or more"),
        (["--session-id", "thor-culture-agents.ses.01JDQ5V7M2K8X9Y0Z1A2B3C4D5"], "--deadline-in"),
    ],
)
def test_submit_flags_that_do_not_fit_a_remote_run_are_a_user_error(
    remote, capsys, extra, message
) -> None:
    r = run(capsys, *SUBMIT, *extra)
    assert r.rc == 1
    assert message in r.err
    assert remote.seen("POST", "/v1/fleet/runs") == []


def test_base_without_alias_is_a_user_error(remote, capsys) -> None:
    argv = [a for a in SUBMIT if a not in ("--alias", "culture-agents")]
    r = run(capsys, *argv, "--repo", "/srv/repos/demo", "--no-base")
    assert r.rc == 1
    assert "--no-base goes with --alias" in r.err
    assert run(capsys, *argv).rc == 1, "neither --repo nor --alias"


def test_steer_cancel_show_and_attach_reach_the_member_the_run_id_names(remote, capsys) -> None:
    caller = ["--caller", "thor-operator"]
    assert run(capsys, "runs", "steer", RUN_ID, "Also cover the null case.", *caller).rc == 0
    assert run(capsys, "runs", "cancel", RUN_ID, "--reason", "enough").rc == 0
    base = f"/v1/fleet/runs/{RUN_ID}"
    assert_valid(
        "control-action.json#/$defs/steer_request", remote.seen("POST", f"{base}/steer")[0]["body"]
    )
    assert_valid(
        "control-action.json#/$defs/cancel_request",
        remote.seen("POST", f"{base}/cancel")[0]["body"],
    )
    assert remote.seen("POST", f"/v1/runs/{RUN_ID}/steer") == []
    shown = run(capsys, "runs", "show", RUN_ID, "--json")
    assert shown.rc == 0, shown.err
    assert shown.json() == fixture("remote", "root.queued")
    attach = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert attach.rc == 0, attach.err
    assert len(attach.out.splitlines()) == len(remote.events)
    assert [q["path"] for q in remote.requests if q["path"].endswith("/attach")] == [
        f"{base}/attach"
    ]


def test_a_run_on_this_core_keeps_the_local_routes(core, capsys) -> None:
    assert run(capsys, "runs", "steer", RUN_ID, "go").rc == 0
    assert len(core.seen("POST", f"/v1/runs/{RUN_ID}/steer")) == 1
    assert core.seen("POST", f"/v1/fleet/runs/{RUN_ID}/steer") == []


def test_a_member_refusal_surfaces_as_its_typed_error(remote, capsys) -> None:
    body = {
        "error": {
            "code": "unavailable",
            "message": "thor did not answer: no answer from the member within 5000 ms",
            "retryable": True,
        }
    }
    remote.respond("POST /v1/fleet/runs/{id}/steer", 503, body)
    r = run(capsys, "runs", "steer", RUN_ID, "hello?", "--idempotency-key", "steer-1")
    assert r.rc == 2
    assert "thor did not answer" in r.err
    assert remote.effects(f"/v1/fleet/runs/{RUN_ID}/steer") == 1, "retried with the same key only"


def test_agents_aliases_reads_a_members_aliases(remote, capsys) -> None:
    r = run(capsys, "agents", "aliases", "--member", "thor")
    assert r.rc == 0, r.err
    assert remote.seen("GET", "/v1/fleet/aliases")[0]["query"] == {"member": "thor"}
    assert "culture-agents: thor-culture-agents on claude-code" in r.out
    assert "demo: nothing permitted" in r.out
    assert run(capsys, "agents", "aliases", "--member", "thor", "--json").json() == fixture(
        "remote", "alias_list.two"
    )
