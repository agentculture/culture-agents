"""t23: remote runs between two real cores, driven through the real ``agents`` CLI (mock stage).

Two built cores run as two processes on loopback, each with its own key, trust list, control
socket and run store. The executing core is thor's fixture, with the stub harness and one
repository it calls ``acc``. The calling core must hold another node name (c40): it uses
``OTHER_NODE``, length-boundary filler that names no host. The caller's operator submits, steers,
attaches and cancels with the CLI on the caller's socket only; thor's CLI is used to check what
thor recorded. The stub's task language: ``files: a, b`` writes those files one at a time, and a
steer ``files: ...`` replaces the ones not yet written; ``hang`` runs until cancelled.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import pytest

from tests.acceptance.d1.support import AGENT, branch_files, require_core_build, wait_for
from tests.acceptance.d2.test_fleet_members import OTHER_NODE, Member

MANY = "files: " + ", ".join(f"f{i:02d}.txt" for i in range(1, 31))  # 30 steps of 150 ms


@pytest.fixture
def fleet() -> Iterator[tuple[Member, Member]]:
    """thor (executing, alias ``acc`` on an allow-listed repository) and the calling core."""
    require_core_build()
    thor, caller = Member("thor"), Member(OTHER_NODE)
    try:
        thor.trust(caller)
        caller.trust(thor)
        # A remote submit is admitted only on a known, admitting heat signal (t24): thor's says admit.
        heat = thor.core.root / "heat.json"
        heat.write_text(json.dumps({"at": time.time(), "stale_after_s": 3600, "level": "normal", "admit": True}))
        thor.core.env["HEAT_GOVERNOR_STATE"] = str(heat)
        repo = thor.core.add_repo()
        (thor.fleet_dir / "aliases.json").write_text(
            json.dumps({"version": 1, "aliases": [{"alias": "acc", "repo": str(repo)}]})
        )
        caller.announce_to(thor)
        thor.core.start()
        caller.core.start()
        wait_for("the caller to list thor", lambda: caller.listed() == ["thor"], 20)
        yield thor, caller
    finally:
        caller.core.close()
        thor.core.close()


def _submit(caller: Member, task: str, *extra: str):
    argv = ("runs", "submit", "--agent", AGENT, "--harness", "stub", "--alias", "acc")
    return caller.core.cli(*argv, "--task", task, *extra, "--json")


def test_a_run_submitted_from_the_caller_runs_on_thor_and_is_steered_from_the_caller(
    fleet,
) -> None:
    thor, caller = fleet
    sent = _submit(caller, MANY, "--no-base", "--deadline-in", "600")
    assert sent.rc == 0, sent.err
    run = sent.json()["run"]
    assert run["submitter"] == {"kind": "member", "node": OTHER_NODE}
    on_thor = thor.core.show(run["id"])
    assert on_thor["submitter"] == {"kind": "member", "node": OTHER_NODE}
    assert on_thor["repo"] == str(thor.core.repos[0])
    assert on_thor["base_commit"] == run["base_commit"]
    created, deadline = on_thor["created_at"], on_thor["deadline"]
    assert deadline is not None and created < deadline, "the deadline is on thor's clock"

    thor.core.wait_outputs(run["id"], "tool_result", 2, 15)
    steer = caller.core.cli("runs", "steer", run["id"], "files: steered.txt", "--json")
    assert steer.rc == 0, steer.err
    assert steer.json()["action"]["outcome"] == "accepted"
    attached = caller.core.cli("runs", "attach", run["id"], "--json", timeout=60)
    assert attached.rc == 0, attached.err
    events = [json.loads(line) for line in attached.out.splitlines()]
    assert [e["cursor"] for e in events] == list(range(1, len(events) + 1))
    assert events[-1]["data"]["to"] == "succeeded"
    assert any(e["kind"] == "run.control" for e in events), "the steer is in the log"
    files = branch_files(thor.core.repos[0], run["id"])
    assert "steered.txt" in files, "the steer changed what the harness did on thor"
    assert "f30.txt" not in files


def test_a_run_is_cancelled_from_the_caller_and_a_named_commit_thor_lacks_is_refused(
    fleet,
) -> None:
    thor, caller = fleet
    # The CLI runs in this repository's checkout, whose HEAD thor's repository does not hold.
    refused = _submit(caller, "hang")
    assert refused.rc == 1, refused.err
    detail = json.loads(refused.err)
    assert (detail["error_code"], detail["field"]) == ("invalid", "/base_commit")
    assert "has no commit" in detail["message"]

    sent = _submit(caller, "hang", "--no-base")
    assert sent.rc == 0, sent.err
    run_id = sent.json()["run"]["id"]
    thor.core.wait_run(run_id, lambda r: r["state"] == "running", "running", 15)
    cancel = caller.core.cli("runs", "cancel", run_id, "--reason", "acceptance", "--json")
    assert cancel.rc == 0, cancel.err
    assert thor.core.wait_terminal(run_id, 20)["state"] == "cancelled"
    shown = caller.core.cli("runs", "show", run_id, "--json")
    assert shown.json()["state"] == "cancelled"
    assert "repo" not in shown.json(), "the caller never sees thor's path"
    aliases = caller.core.cli("agents", "aliases", "--member", "thor", "--json")
    assert aliases.json() == {
        "node": "thor",
        "aliases": [{"alias": "acc", "permits": [{"agent_id": AGENT, "harness": "stub"}]}],
    }
