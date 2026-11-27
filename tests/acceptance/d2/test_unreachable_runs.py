"""t25: a run on a halted member reads unreachable through the real CLI, never a state (mock stage).

Two built cores on loopback, as in ``test_remote_runs``. The executing core, thor, is halted with
SIGSTOP (the host stops answering; the kernel still accepts connections), so the caller's call
times out. Every read of the run on the caller reads ``unreachable``, none succeeds, and the
caller's own state directory is byte-identical before and after. When thor continues, the same
command shows the run's true state.
"""

from __future__ import annotations

import hashlib
import os
import signal
from pathlib import Path

from tests.acceptance.d1.support import wait_for
from tests.acceptance.d2.test_remote_runs import _submit, fleet  # noqa: F401  (the fixture)


def _tree(root: Path) -> dict[str, str]:
    """Every regular file under ``root`` with a digest of its content."""
    seen: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_socket():
            seen[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return seen


def _state(member) -> dict[str, str]:
    """The core's state and configuration directories (its log file is not state)."""
    return {**_tree(member.core.state_dir), **_tree(member.core.config_home)}


def test_a_halted_member_reads_unreachable_and_shows_its_true_state_when_it_answers(
    fleet,  # noqa: F811
) -> None:
    thor, caller = fleet
    run_id = _submit(caller, "hang", "--no-base").json()["run"]["id"]
    thor.core.wait_run(run_id, lambda r: r["state"] == "running", "running", 15)
    first = caller.core.cli("runs", "show", run_id, "--json")
    assert first.json()["state"] == "running"

    proc = thor.core.proc
    assert proc is not None
    os.kill(proc.pid, signal.SIGSTOP)
    try:
        before = _state(caller)
        reads = [caller.core.cli("runs", "show", run_id, "--json") for _ in range(2)]
        assert [r.rc for r in reads] == [0, 0], [r.err for r in reads]
        assert [r.json()["view"] for r in reads] == ["unreachable", "unreachable"]
        assert all("state" not in r.json() for r in reads), "0 reads succeeded"
        text = caller.core.cli("runs", "show", run_id)
        assert "state: unreachable" in text.out
        assert "succeeded" not in text.out
        assert _state(caller) == before, "the caller wrote nothing"
    finally:
        os.kill(proc.pid, signal.SIGCONT)

    def answers() -> bool:
        return "state" in caller.core.cli("runs", "show", run_id, "--json").json()

    wait_for("thor to answer the caller again", answers, 30)
    cancel = caller.core.cli("runs", "cancel", run_id, "--reason", "acceptance", "--json")
    assert cancel.rc == 0, cancel.err
    assert thor.core.wait_terminal(run_id, 20)["state"] == "cancelled"
    shown = caller.core.cli("runs", "show", run_id, "--json")
    assert shown.json()["state"] == "cancelled", "the true terminal state, not a stored unreachable"
