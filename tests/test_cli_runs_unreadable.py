"""``agents runs unreadable`` and the warning of ``agents runs list`` against the fake core."""

from __future__ import annotations

import pytest

from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture

LISTED = fixture("unreadable", "root.newer-and-corrupt")


def test_list_prints_one_warning_line_and_json_carries_the_count(core, capsys) -> None:
    core.respond("GET /v1/runs/unreadable", 200, LISTED)
    text = run(capsys, "runs", "list")
    assert text.rc == 0
    lines = text.out.splitlines()
    assert lines[-1] == "warning: 3 runs could not be read; list them with: agents runs unreadable"
    assert sum("could not be read" in line for line in lines) == 1
    assert RUN_ID in text.out
    as_json = run(capsys, "runs", "list", "--json").json()
    assert as_json == {**fixture("run", "run_list.two-runs"), "unreadable_count": 3}


def test_list_says_nothing_when_every_run_can_be_read(core, capsys) -> None:
    assert "could not be read" not in run(capsys, "runs", "list").out


def test_one_unreadable_run_is_singular(core, capsys) -> None:
    one = {"count": 1, "runs": LISTED["runs"][:1]}
    core.respond("GET /v1/runs/unreadable", 200, one)
    assert "warning: 1 run could not be read;" in run(capsys, "runs", "list").out


def test_unreadable_lists_each_run_with_reason_and_detail(core, capsys) -> None:
    core.respond("GET /v1/runs/unreadable", 200, LISTED)
    r = run(capsys, "runs", "unreadable")
    assert r.rc == 0
    assert "unreadable runs (3):" in r.out
    assert f"{LISTED['runs'][0]['run_id']}  newer_version  the run directory uses" in r.out
    assert run(capsys, "runs", "unreadable", "--json").json() == LISTED


def test_unreadable_text_from_a_run_directory_is_shown_escaped(core, capsys) -> None:
    hostile = {"count": 1, "runs": [{**LISTED["runs"][1], "detail": "bad \x1b[31m\nrecord"}]}
    core.respond("GET /v1/runs/unreadable", 200, hostile)
    out = run(capsys, "runs", "unreadable").out
    assert "\x1b" not in out
    assert "bad \\x1b[31m\\nrecord" in out


def test_an_empty_list_says_so(core, capsys) -> None:
    assert run(capsys, "runs", "unreadable").out.strip() == "no unreadable runs"


@pytest.mark.parametrize("verb", ["list", "unreadable"])
def test_the_requests_carry_the_current_version(core, capsys, verb) -> None:
    run(capsys, "runs", verb)
    assert core.seen("GET", "/v1/runs/unreadable")[0]["version_header"] == "3.2"
