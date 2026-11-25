"""D1 acceptance, live stage: Claude Code and OpenCode v2 in an OpenShell sandbox.

Opt-in (``CULTURE_AGENTS_ACCEPTANCE_LIVE=1``): each check spends a real harness
turn. Without the opt-in, or when the core reports the harness as unavailable
(no gateway, run image or credential provider), the check is skipped as
``NOT VERIFIED``. Results are appended to ``$CULTURE_AGENTS_ACCEPTANCE_REPORT``
and recorded by hand in ``docs/d0/d1-acceptance.md``.
"""

from __future__ import annotations

import time

import pytest

from tests.acceptance.d1 import netcheck
from tests.acceptance.d1.support import (
    Core,
    branch_files,
    host_untouched,
    record,
    states,
)

TURN_TIMEOUT = 300

TASKS = {
    "claude-code": {
        "complete": (
            "Create a file named hello.txt containing the word hi, using your Write tool. "
            "Then reply with the single word done."
        ),
        "steps": (
            "Create ten files named file01.txt to file10.txt in the current directory, ONE AT A "
            "TIME with a separate Write tool call each (never in parallel, never via Bash). Each "
            "file contains just its number. Do not explain."
        ),
        "last": "file10.txt",
        "count": 10,
        "hang": (
            "Run the shell command: sleep 120 && echo late > late.txt . Use the Bash tool. "
            "Then write done.txt."
        ),
    },
    "opencode": {
        "complete": (
            "Create a file named hello.txt containing the word hi, using your write tool. "
            "Then reply with the single word done."
        ),
        "steps": (
            "Run these six shell commands ONE AT A TIME, each as its own separate bash tool call, "
            "never in parallel: sleep 3 && echo 1 > file1.txt ; sleep 3 && echo 2 > file2.txt ; "
            "sleep 3 && echo 3 > file3.txt ; sleep 3 && echo 4 > file4.txt ; "
            "sleep 3 && echo 5 > file5.txt ; sleep 3 && echo 6 > file6.txt . Then reply done."
        ),
        "last": "file6.txt",
        "count": 6,
        "hang": (
            "Run the shell command: sleep 120 && echo late > late.txt . Use one bash tool call "
            "in the foreground. Then create done.txt."
        ),
    },
}
STEER = (
    "Change of plan: do not create any more numbered files. Instead create a file named "
    "STEERED.txt containing the word steered, then reply done."
)
HARNESSES = pytest.mark.parametrize("live_core", sorted(TASKS), indirect=True)


def _harness(core: Core) -> str:
    return core.harnesses[0]


def _no_chat_connection(core: Core) -> dict[str, object]:
    """No TCP socket of the core or its workers reaches a chat server port."""
    assert core.proc is not None
    chat = netcheck.chat_ports()
    remote = sorted(
        {
            port
            for pid in [core.proc.pid, *core.worker_pids()]
            for _, port, _, listening in netcheck.tcp_sockets(pid)
            if not listening
        }
    )
    assert not set(remote) & chat, f"a core process is connected to a chat port: {remote}"
    return {"remote_ports": remote, "chat_servers_on_host": len(netcheck.chat_servers())}


@HARNESSES
def test_live_submit_is_fast_and_the_harness_completes_a_task(live_core: Core) -> None:
    harness = _harness(live_core)
    repo = live_core.add_repo()
    run, seconds = live_core.submit(harness, repo, TASKS[harness]["complete"])
    assert seconds < 2.0, f"submit took {seconds:.2f} s"
    live_core.wait_run(run["id"], lambda r: r["state"] != "queued", "started", TURN_TIMEOUT)
    net = _no_chat_connection(live_core)
    done = live_core.wait_terminal(run["id"], TURN_TIMEOUT)
    result = live_core.ok("runs", "result", run["id"])
    record(
        "live.complete",
        harness=harness,
        submit_seconds=round(seconds, 3),
        state=done["state"],
        files=branch_files(repo, run["id"]),
        commits=len(result["commits"]),
        error=result["error"],
        **net,
    )
    assert done["state"] == "succeeded", result["error"]
    assert result["branch"] == f"runs/{run['id']}"
    assert result["commits"]
    assert "hello.txt" in branch_files(repo, run["id"])
    assert host_untouched(repo)


@HARNESSES
def test_live_steer_changes_subsequent_output(live_core: Core) -> None:
    """The steer is accepted mid-run and what it asks for is produced after it.

    Whether the model also drops the rest of its original plan is its own choice, so that
    is recorded (``plan_abandoned``) and not asserted.
    """
    harness = _harness(live_core)
    repo = live_core.add_repo()
    run, _ = live_core.submit(harness, repo, TASKS[harness]["steps"])
    live_core.wait_outputs(run["id"], "tool_result", 2, TURN_TIMEOUT)
    steer = live_core.ok("runs", "steer", run["id"], STEER)
    done = live_core.wait_terminal(run["id"], TURN_TIMEOUT)
    files = branch_files(repo, run["id"])
    events = live_core.events(run["id"])
    at = next(i for i, e in enumerate(events) if e["kind"] == "run.control")
    calls = [e["data"]["text"] for e in events if e["data"].get("channel") == "tool_call"]
    after = [e["data"]["text"] for e in events[at:] if e["data"].get("channel") == "tool_call"]
    steered = next((i for i, text in enumerate(after) if "STEERED" in text), None)
    record(
        "live.steer",
        harness=harness,
        state=done["state"],
        files=files,
        tool_calls_before_steer=len(calls) - len(after),
        tool_calls_between_steer_and_steered_file=steered,
        plan_abandoned=TASKS[harness]["last"] not in files,
    )
    assert steer["action"]["outcome"] == "accepted"
    assert done["state"] == "succeeded"
    assert "STEERED.txt" in files, "the steer produced its file"
    assert steered is not None, "and it was written after the steer was accepted"


@HARNESSES
def test_live_cancel_reaches_cancelled_in_under_10_seconds(live_core: Core) -> None:
    harness = _harness(live_core)
    repo = live_core.add_repo()
    run, _ = live_core.submit(harness, repo, TASKS[harness]["hang"])
    live_core.wait_outputs(run["id"], "tool_call", 1, TURN_TIMEOUT)
    time.sleep(3)
    start = time.monotonic()
    live_core.ok("runs", "cancel", run["id"], "--reason", "acceptance")
    done = live_core.wait_terminal(run["id"], 60)
    seconds = time.monotonic() - start
    record("live.cancel", harness=harness, state=done["state"], seconds=round(seconds, 2))
    assert done["state"] == "cancelled"
    assert states(live_core.events(run["id"]))[-2:] == ["cancelling", "cancelled"]
    assert seconds < 10.0, f"cancel took {seconds:.1f} s"
    assert branch_files(repo, run["id"]) == []


@HARNESSES
def test_live_kill_9_and_restart_reports_every_run_truthfully(live_core: Core) -> None:
    harness = _harness(live_core)
    repo = live_core.add_repo()
    run, _ = live_core.submit(harness, repo, TASKS[harness]["steps"])
    live_core.wait_outputs(run["id"], "tool_result", 1, TURN_TIMEOUT)
    live_core.kill9()
    live_core.start()
    listed = {r["id"]: r for r in live_core.ok("runs", "list")["runs"]}
    assert set(listed) == {run["id"]}
    after_restart = listed[run["id"]]
    assert after_restart["state"] == "running", "the worker outlived the core and is still at work"
    assert not after_restart["live_control"], "a surviving worker is reported without live control"
    done = live_core.wait_terminal(run["id"], TURN_TIMEOUT)
    files = branch_files(repo, run["id"])
    record(
        "live.restart",
        harness=harness,
        state_after_restart=after_restart["state"],
        final_state=done["state"],
        files=files,
    )
    assert done["state"] == "succeeded", "the surviving worker finishes its task on its own"
    assert states(live_core.events(run["id"]))[-1] == "succeeded"
    numbered = [f for f in files if f.startswith("file")]
    assert len(numbered) == TASKS[harness]["count"], "every file of the task is on the run's branch"
