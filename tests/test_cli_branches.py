"""``agents branches list|remove`` against the fake core: text, ``--json``, requests, refusals."""

from __future__ import annotations

import pytest

from culture_agents.cli._app import get_app
from culture_agents.explain.catalog import ENTRIES
from tests.cli_support import assert_valid, run
from tests.fake_core import fixture

REPO = "/srv/repos/demo"


def test_list_text_shows_state_and_evidence(core, capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "branches", "list", "--repo", REPO)
    assert r.rc == 0
    lines = r.out.strip().splitlines()
    assert len(lines) == 2
    assert "succeeded" in lines[0] and "reachable from main" in lines[0]
    assert "running" in lines[1] and "not reachable from another ref" in lines[1]
    assert core.seen("GET", "/v1/branches")[0]["query"] == {"repo": REPO}


def test_list_json_is_the_contract_payload(core, capsys) -> None:
    r = run(capsys, "branches", "list", "--repo", REPO, "--json")
    assert r.rc == 0
    assert r.json() == fixture("branches", "root.two-branches")
    assert_valid("branches.json", r.json())


def test_list_names_an_unreadable_run(core, capsys) -> None:
    core.respond("GET /v1/branches", 200, fixture("branches", "root.unreadable-run"))
    r = run(capsys, "branches", "list", "--repo", REPO)
    assert r.rc == 0
    assert "the run cannot be read" in r.out


def test_list_with_no_branches(core, capsys) -> None:
    core.respond("GET /v1/branches", 200, fixture("branches", "root.empty"))
    assert run(capsys, "branches", "list", "--repo", REPO).out.strip() == "no runs branches"


def test_remove_reports_deleted_and_skipped(core, capsys) -> None:
    r = run(capsys, "branches", "remove", "--repo", REPO)
    assert r.rc == 0
    assert "deleted runs/" in r.out and "skipped runs/" in r.out and "active" in r.out
    sent = core.seen("POST", "/v1/branches/remove")[0]["body"]
    assert sent == {"repo": REPO}
    assert_valid("branches.json#/$defs/remove_request", sent)


def test_remove_dry_run_is_sent_and_worded(core, capsys) -> None:
    core.respond(
        "POST /v1/branches/remove",
        200,
        {**fixture("branches", "remove_response.mixed"), "dry_run": True},
    )
    r = run(capsys, "branches", "remove", "--repo", REPO, "--dry-run", "--json")
    assert r.rc == 0
    sent = core.seen("POST", "/v1/branches/remove")[0]["body"]
    assert sent == {"repo": REPO, "dry_run": True}
    assert_valid("branches.json#/$defs/remove_request", sent)
    text = run(capsys, "branches", "remove", "--repo", REPO, "--dry-run").out
    assert "would delete runs/" in text


def test_a_repository_the_core_denies_exits_1_with_its_code(core, capsys) -> None:
    core.respond("GET /v1/branches", 403, fixture("error", "root.denied"))
    r = run(capsys, "branches", "list", "--repo", REPO, "--json")
    assert r.rc == 1
    assert r.err_json()["error_code"] == "denied"


def test_an_invalid_core_response_is_an_internal_error(core, capsys) -> None:
    core.respond("POST /v1/branches/remove", 200, {"repo": REPO})
    r = run(capsys, "branches", "remove", "--repo", REPO)
    assert r.rc == 2


def test_repo_is_required(core, capsys) -> None:
    assert run(capsys, "branches", "list").rc == 1


def test_every_branches_verb_has_an_explain_entry_and_a_json_flag(capsys) -> None:
    for verb in ("list", "remove"):
        assert ("branches", verb) in ENTRIES
        r = run(capsys, "explain", "branches", verb)
        assert r.rc == 0 and f"agents branches {verb}" in r.out
    assert ("branches",) in ENTRIES
    assert get_app() is not None
