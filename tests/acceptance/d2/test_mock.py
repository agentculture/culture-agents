"""D2 part one acceptance, mock stage: the real CLI and the real core, with the stub harness.

The five checks of the spec's success signal, then the timing check. The stub reads a
tiny task language (``hang``, ``files: a.txt``, ``ask: <text>``); see ``core/src/harness/stub``.
"""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path

from tests.acceptance.d1.support import AGENT, Core, record, states, wait_for
from tests.acceptance.d2.conftest import MakeCore

RUNNING = "running"


def _running(core: Core, run_id: str) -> None:
    core.wait_run(run_id, lambda r: r["state"] == RUNNING, "running", 10)


def _submit_keyed(core: Core, repo: Path, task: str, key: str):
    return core.cli(
        *("runs", "submit", "--agent", AGENT, "--harness", "stub", "--repo", str(repo)),
        *("--task", task, "--idempotency-key", key, "--json"),
    )


def test_check1_restart_with_2_runs_in_1_repository_then_steer_one_and_cancel_the_other(
    make_core: MakeCore,
) -> None:
    core = make_core()
    repo = core.add_repo()
    first, _ = core.submit("stub", repo, "hang")
    second, _ = core.submit("stub", repo, "hang")
    _running(core, first["id"])
    _running(core, second["id"])
    pids = {r: core.show(r)["worker_pid"] for r in (first["id"], second["id"])}

    core.kill9()
    core.start()
    for run_id, pid in pids.items():
        shown = core.show(run_id)
        assert shown["state"] == RUNNING and shown["live_control"], "reattached to the survivor"
        assert pid in core.worker_pids(), "the restart signalled no worker"

    steer = core.ok("runs", "steer", first["id"], "after the restart")
    assert steer["action"]["outcome"] == "accepted"
    cancel = core.ok("runs", "cancel", second["id"], "--reason", "acceptance")
    assert cancel["action"]["outcome"] == "accepted"
    assert core.wait_run(second["id"], lambda r: r["terminal"], "terminal", 10)["state"] == (
        "cancelled"
    )
    kinds = [e["kind"] for e in core.events(first["id"])]
    assert "run.control" in kinds, "the steer is in the first run's log"
    assert core.show(first["id"])["state"] == RUNNING, "the cancel did not touch the other run"
    core.ok("runs", "cancel", first["id"])
    record("mock.d2.restart_steer_cancel", runs=2, steer="accepted", cancel="cancelled")


def test_check2_one_key_sent_twice_gives_one_run_and_a_changed_request_conflicts(
    make_core: MakeCore,
) -> None:
    core = make_core()
    repo = core.add_repo()
    one = _submit_keyed(core, repo, "files: a.txt", "acc-key-1")
    two = _submit_keyed(core, repo, "files: a.txt", "acc-key-1")
    assert one.rc == 0 and two.rc == 0, (one.err, two.err)
    assert one.json()["run"]["id"] == two.json()["run"]["id"]
    assert [r["id"] for r in core.ok("runs", "list")["runs"]] == [one.json()["run"]["id"]]

    changed = _submit_keyed(core, repo, "files: b.txt", "acc-key-1")
    assert changed.rc == 1
    assert changed.error_code() == "conflict"
    assert len(core.ok("runs", "list")["runs"]) == 1, "the conflict created no run"
    core.wait_terminal(one.json()["run"]["id"], 20)
    record("mock.d2.idempotency", runs_for_two_sends=1, changed_request=changed.error_code())


def test_check3_a_question_survives_a_restart_and_is_answered(make_core: MakeCore) -> None:
    core = make_core()
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, "ask: which name?\nfiles: named.txt")
    pending = core.wait_run(
        run["id"], lambda r: bool(r.get("pending_questions")), "holding a question", 15
    )["pending_questions"]
    assert len(pending) == 1
    question = pending[0]["id"]

    core.kill9()
    core.start()
    after = core.show(run["id"])
    assert [q["id"] for q in after["pending_questions"]] == [question], "still pending"
    assert after["state"] == RUNNING and after["live_control"]

    answered = core.ok("runs", "answer", run["id"], "--question", question, "--answer", "blue")
    assert answered["action"]["outcome"] == "accepted"
    assert core.wait_terminal(run["id"], 20)["state"] == "succeeded"
    assert core.show(run["id"])["pending_questions"] == []
    again = core.cli(
        "runs", "answer", run["id"], "--question", question, "--answer", "red", "--json"
    )
    assert again.rc == 1 and again.error_code() == "conflict", "a question takes one answer"
    kinds = [e["kind"] for e in core.events(run["id"])]
    assert kinds.count("run.question") == 1 and kinds.count("run.answer") == 1
    record("mock.d2.question", survived_restart=True, answers_logged=1)


def test_check4_a_submit_past_a_configured_limit_is_refused_with_the_typed_error(
    make_core: MakeCore,
) -> None:
    core = make_core(limits={"runsPerRepository": 2})
    repo = core.add_repo()
    other = core.add_repo()
    first, _ = core.submit("stub", repo, "hang")
    second, _ = core.submit("stub", repo, "hang")
    refused = core.cli(
        *("runs", "submit", "--agent", AGENT, "--harness", "stub", "--repo", str(repo)),
        *("--task", "hang", "--json"),
    )
    assert refused.rc == 1
    assert refused.error_code() == "limit_reached"
    assert len(core.ok("runs", "list")["runs"]) == 2, "the refused submit created no run"
    third, _ = core.submit("stub", other, "hang")  # the limit is per repository
    for run in (first, second, third):
        core.ok("runs", "cancel", run["id"])
    record("mock.d2.limit", configured=2, refused=refused.error_code())


def test_check5_no_run_reports_succeeded_without_a_worker_terminal_event(
    make_core: MakeCore,
) -> None:
    core = make_core()
    repos = [core.add_repo() for _ in range(3)]
    finished, _ = core.submit("stub", repos[0], "files: done.txt")
    assert core.wait_terminal(finished["id"], 20)["state"] == "succeeded"
    orphan, _ = core.submit("stub", repos[1], "hang")
    survivor, _ = core.submit("stub", repos[2], "hang")
    _running(core, orphan["id"])
    _running(core, survivor["id"])
    orphan_pid = core.show(orphan["id"])["worker_pid"]

    core.kill9()
    os.kill(orphan_pid, signal.SIGKILL)
    wait_for("the worker to die", lambda: orphan_pid not in core.worker_pids(), 5)
    core.start()

    listed = {r["id"]: r for r in core.ok("runs", "list")["runs"]}
    assert listed[orphan["id"]]["state"] == "unknown", "a dead worker is unknown, not success"
    succeeded = [r["id"] for r in listed.values() if r["state"] == "succeeded"]
    assert succeeded == [finished["id"]]
    for run_id in succeeded:
        assert states(core.events(run_id))[-1] == "succeeded", "backed by the worker's event"
    assert "succeeded" not in states(core.events(orphan["id"]))
    core.ok("runs", "cancel", survivor["id"])
    record("mock.d2.honest_success", runs=len(listed), succeeded_without_event=0)


def test_third_submit_to_another_repository_is_fast_and_cancel_is_under_10_seconds(
    make_core: MakeCore,
) -> None:
    core = make_core(limits={"runsPerRepository": 2})
    busy, other = core.add_repo(), core.add_repo()
    first, _ = core.submit("stub", busy, "hang")
    second, _ = core.submit("stub", busy, "hang")
    _running(core, first["id"])
    _running(core, second["id"])

    third, submit_seconds = core.submit("stub", other, "hang")
    assert third["id"] and submit_seconds < 2.0, f"submit took {submit_seconds:.2f} s"
    _running(core, third["id"])

    start = time.monotonic()
    core.ok("runs", "cancel", third["id"], "--reason", "acceptance")
    core.wait_run(third["id"], lambda r: r["state"] == "cancelled", "cancelled", 10)
    cancel_seconds = time.monotonic() - start
    assert cancel_seconds < 10.0, f"cancel took {cancel_seconds:.2f} s"
    core.ok("runs", "cancel", first["id"])
    core.ok("runs", "cancel", second["id"])
    record(
        "mock.d2.timing",
        submit_seconds=round(submit_seconds, 3),
        cancel_seconds=round(cancel_seconds, 3),
    )
