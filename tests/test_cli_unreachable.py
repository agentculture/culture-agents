"""``agents runs show`` on a run on another member: the unreachable view (API 3.3, task t25)."""

from __future__ import annotations

import pytest

from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture

CALLER_NODE = "xxxxxxxx"



@pytest.fixture
def remote(core):
    core.respond(
        "GET /v1/version", 200, {**fixture("version", "root.current"), "node": CALLER_NODE}
    )
    return core



def test_an_unreachable_run_shows_unreachable_and_no_state(remote, capsys) -> None:
    remote.respond(
        "GET /v1/fleet/runs/{id}/view", 200, fixture("reachability", "root.unreachable-no-answer")
    )
    shown = run(capsys, "runs", "show", RUN_ID)
    assert shown.rc == 0, shown.err
    assert "state: unreachable (no_answer)" in shown.out
    assert "succeeded" not in shown.out
    assert "not known here" in shown.out
    as_json = run(capsys, "runs", "show", RUN_ID, "--json").json()
    assert as_json == fixture("reachability", "root.unreachable-no-answer")
    assert "state" not in as_json, "a caller that cannot read a run has no state to show"
    assert remote.seen("GET", f"/v1/fleet/runs/{RUN_ID}") == [], "only the view route was read"


def test_a_reachable_run_shows_the_members_answer_as_before(remote, capsys) -> None:
    shown = run(capsys, "runs", "show", RUN_ID)
    assert shown.rc == 0, shown.err
    assert "state: queued" in shown.out
    assert run(capsys, "runs", "show", RUN_ID, "--json").json() == fixture("remote", "root.queued")
