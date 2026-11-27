"""``agents runs result`` and ``logs`` on a run on another fleet member (API 3.3, t26).

The fake core reports node ``xxxxxxxx`` (filler that names no host), so the
example run of node ``thor`` is on another member. Its result and logs come
from ``/v1/fleet/runs/{id}/result`` and ``/events``, and its branch from a real
git bundle served at ``/v1/fleet/runs/{id}/bundle``, which the CLI fetches into
the caller's checkout.
"""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - fixed git invocations to build test repositories
from pathlib import Path

import pytest

from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture

CALLER_NODE = "xxxxxxxx"
BRANCH = f"runs/{RUN_ID}"
GIT = shutil.which("git") or "git"
ENV = {"GIT_CONFIG_NOSYSTEM": "1", "PATH": "/usr/bin:/bin"}


def _git(cwd: Path, *args: str) -> str:
    done = subprocess.run(  # nosec B603 - fixed arguments, no shell
        [GIT, *args], cwd=cwd, env={**ENV, "HOME": str(cwd)}, capture_output=True, text=True
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def _empty(cwd: Path, message: str) -> str:
    who = ("-c", "user.name=t", "-c", "user.email=t@t.invalid")
    _git(cwd, *who, "commit", "-q", "--allow-empty", "-m", message)
    return _git(cwd, "rev-parse", "HEAD")


@pytest.fixture
def project(tmp_path) -> dict:
    """thor's repository with a run branch and another branch, and the caller's clone of it."""
    thor = tmp_path / "thor"
    thor.mkdir()
    _git(thor, "init", "-q", "-b", "main")
    base = _empty(thor, "base")
    mine = tmp_path / "mine"
    _git(tmp_path, "clone", "-q", str(thor), str(mine))
    _git(thor, "checkout", "-q", "-b", "elsewhere")
    secret = _empty(thor, "not the run's")
    _git(thor, "checkout", "-q", "-b", BRANCH, base)
    tip = [_empty(thor, "run one"), _empty(thor, "run two")][-1]
    bundle = tmp_path / "run.bundle"
    _git(thor, "bundle", "create", "-q", str(bundle), f"refs/heads/{BRANCH}", f"^{base}")
    return {"mine": mine, "tip": tip, "secret": secret, "base": base, "bundle": bundle}


@pytest.fixture
def remote(core):
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "node": CALLER_NODE}
    )
    return core


def test_result_of_a_remote_run_brings_its_branch_into_the_checkout(
    remote, capsys, project
) -> None:
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, project["bundle"].read_bytes())
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]), "--json")
    assert r.rc == 0, r.err
    body = r.json()
    assert body["fetched"] == {
        "branch": BRANCH,
        "into": str(project["mine"]),
        "tip": project["tip"],
    }
    assert body["run_id"] == RUN_ID
    assert _git(project["mine"], "rev-parse", BRANCH) == project["tip"]
    secret = subprocess.run(  # nosec B603
        [GIT, "cat-file", "-e", project["secret"]], cwd=project["mine"], capture_output=True
    )
    assert secret.returncode != 0, "nothing but the run's commits came over"
    assert remote.seen("GET", f"/v1/fleet/runs/{RUN_ID}/result")
    assert remote.seen("GET", f"/v1/runs/{RUN_ID}/result") == []
    again = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]))
    assert again.rc == 0, again.err
    assert f"fetched: {BRANCH} ({project['tip']}) into {project['mine']}" in again.out


def test_the_checkout_defaults_to_the_one_the_cli_runs_in(
    remote, capsys, project, monkeypatch
) -> None:
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, project["bundle"].read_bytes())
    monkeypatch.chdir(project["mine"])
    assert run(capsys, "runs", "result", RUN_ID).rc == 0
    assert _git(project["mine"], "rev-parse", BRANCH) == project["tip"]


def test_outside_a_checkout_or_with_no_fetch_nothing_is_fetched(
    remote, capsys, tmp_path, monkeypatch
) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.chdir(plain)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    r = run(capsys, "runs", "result", RUN_ID)
    assert r.rc == 0, r.err
    assert "not fetched: not in a git checkout" in r.out
    assert run(capsys, "runs", "result", RUN_ID, "--no-fetch").rc == 0
    assert remote.seen("GET", f"/v1/fleet/runs/{RUN_ID}/bundle") == []
    bad = run(capsys, "runs", "result", RUN_ID, "--into", str(plain))
    assert bad.rc == 1
    assert "is not a git checkout" in bad.err


def test_a_checkout_without_the_base_commit_is_told_what_is_missing(
    remote, capsys, project, tmp_path
) -> None:
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, project["bundle"].read_bytes())
    stranger = tmp_path / "stranger"
    stranger.mkdir()
    _git(stranger, "init", "-q", "-b", "main")
    _empty(stranger, "another project")
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(stranger))
    assert r.rc == 1
    assert "base commit" in r.err


def test_a_bundle_with_other_refs_or_not_a_bundle_is_refused(remote, capsys, project) -> None:
    thor = project["bundle"].parent / "thor"
    wide = project["bundle"].parent / "wide.bundle"
    _git(thor, "bundle", "create", "-q", str(wide), f"refs/heads/{BRANCH}", "refs/heads/elsewhere")
    for payload in (wide.read_bytes(), b"not a bundle"):
        remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, payload)
        r = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]))
        assert r.rc == 2, r.err
    subprocess_ok = subprocess.run(  # nosec B603
        [GIT, "rev-parse", "--verify", "--quiet", BRANCH], cwd=project["mine"], capture_output=True
    )
    assert subprocess_ok.returncode != 0, "nothing was fetched from a bundle it refused"


def test_a_refused_bundle_is_the_members_typed_error(remote, capsys, project) -> None:
    denied = {"error": {"code": "denied", "message": "thor: not yours", "retryable": False}}
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 403, denied)
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]), "--json")
    assert r.rc == 1
    assert r.err_json()["error_code"] == "denied"


def test_logs_of_a_remote_run_come_from_the_fleet_route(remote, capsys) -> None:
    r = run(capsys, "runs", "logs", RUN_ID, "--after", "0", "--limit", "50", "--json")
    assert r.rc == 0, r.err
    assert r.json() == fixture("event", "event_page.first-page")
    sent = remote.seen("GET", f"/v1/fleet/runs/{RUN_ID}/events")
    assert sent[0]["query"] == {"after": "0", "limit": "50"}
    assert remote.seen("GET", f"/v1/runs/{RUN_ID}/events") == []


def test_into_on_a_local_run_is_a_user_error(core, capsys, tmp_path) -> None:
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(tmp_path))
    assert r.rc == 1
    assert "--into goes with a run on another member" in r.err


def test_a_result_naming_another_runs_branch_is_refused_before_any_fetch(
    remote, capsys, project
) -> None:
    other = f"runs/{RUN_ID[:-1]}Z"
    remote.respond(
        "GET /v1/fleet/runs/{id}/result",
        200,
        {**fixture("run", "run_result.succeeded"), "branch": other},
    )
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, project["bundle"].read_bytes())
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]))
    assert r.rc == 2
    assert "not this run's branch" in r.err
    assert remote.seen("GET", f"/v1/fleet/runs/{RUN_ID}/bundle") == []


def test_a_bundle_git_cannot_read_is_named_as_such(remote, capsys, project) -> None:
    remote.respond("GET /v1/fleet/runs/{id}/bundle", 200, b"# v2 git bundle\nnot a bundle\n")
    r = run(capsys, "runs", "result", RUN_ID, "--into", str(project["mine"]))
    assert r.rc == 2
    assert "git cannot read" in r.err
    assert "other refs" not in r.err
