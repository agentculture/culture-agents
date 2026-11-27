"""D1 acceptance, mock stage: the real CLI and the real core, with the stub harness.

The stub reads a tiny task language (``files: a.txt, b.txt`` writes those files
one at a time, ``hang`` runs until interrupted; a steer with ``files: ...``
replaces the files not yet written), so every control path is exercised without
a sandbox or a model. Timings are wall time of the CLI process.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess  # nosec B404
import sys
import time

from tests.acceptance.d1 import netcheck
from tests.acceptance.d1.support import (
    AGENT,
    REPO_ROOT,
    STATES,
    Core,
    branch_files,
    host_untouched,
    record,
    states,
    wait_for,
)

MANY = "files: " + ", ".join(f"f{i:02d}.txt" for i in range(1, 31))  # 30 steps of 150 ms
LONG = "files: " + ", ".join(f"g{i:03d}.txt" for i in range(1, 121))  # 120 steps: about 18 s


def test_submit_returns_a_run_id_in_under_2_seconds_and_the_task_completes(core: Core) -> None:
    repo = core.add_repo()
    run, seconds = core.submit("stub", repo, "files: hello.txt, world.txt")
    assert seconds < 2.0, f"submit took {seconds:.2f} s"
    assert run["id"].startswith(f"{AGENT}.run.")
    assert run["state"] == "queued"

    done = core.wait_terminal(run["id"], 20)
    assert done["state"] == "succeeded"
    result = core.ok("runs", "result", run["id"])
    assert result["state"] == "succeeded"
    assert result["error"] is None
    assert result["branch"] == f"runs/{run['id']}"
    assert len(result["commits"]) == 1
    assert branch_files(repo, run["id"]) == ["README", "hello.txt", "world.txt"]
    assert host_untouched(repo), "the host checkout is never written by a run"
    record("mock.submit", seconds=round(seconds, 3), state=done["state"])


def test_every_inspection_verb_tells_the_same_story(core: Core) -> None:
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, MANY)
    core.wait_run(run["id"], lambda r: r["state"] == "running", "running", 10)
    agent = core.ok("agents", "status", AGENT)
    assert agent["agent"]["state"] == "running"
    assert agent["agent"]["active_run_ids"] == [run["id"]]
    assert [r["id"] for r in core.ok("runs", "list", "--state", "running")["runs"]] == [run["id"]]

    # attach follows the run live to its end, from the first event.
    attach = core.cli("runs", "attach", run["id"], "--json", timeout=30)
    assert attach.rc == 0, attach.err
    streamed = [json.loads(line) for line in attach.out.splitlines()]
    logged = core.events(run["id"])
    assert streamed == logged, "attach and logs report the same events"
    assert [e["cursor"] for e in logged] == list(range(1, len(logged) + 1))
    assert states(logged) == ["queued", "running", "succeeded"]
    assert core.show(run["id"])["cursor"] == len(logged)
    assert core.ok("agents", "status", AGENT)["agent"]["state"] == "idle"


def test_a_mid_run_steer_changes_what_the_harness_does_next(core: Core) -> None:
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, MANY)
    core.wait_outputs(run["id"], "tool_result", 2, 10)
    steer = core.ok("runs", "steer", run["id"], "files: steered.txt")
    assert steer["action"]["outcome"] == "accepted"

    assert core.wait_terminal(run["id"], 20)["state"] == "succeeded"
    events = core.events(run["id"])
    at = next(i for i, e in enumerate(events) if e["kind"] == "run.control")
    assert events[at]["data"]["action"]["id"] == steer["action"]["id"]
    writes = [e["data"]["text"] for e in events[at:] if e["data"].get("channel") == "tool_result"]
    assert writes[-1] == "wrote steered.txt", "the steered file is the last thing written"
    files = branch_files(repo, run["id"])
    assert "steered.txt" in files
    assert "f30.txt" not in files
    assert len(files) < 30, "the files not yet written when the steer arrived were dropped"
    record("mock.steer", files_on_branch=len(files) - 1, writes_after_steer=writes)


def test_cancel_reaches_cancelled_in_under_10_seconds(core: Core) -> None:
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, "hang")
    core.wait_run(run["id"], lambda r: r["state"] == "running", "running", 10)
    start = time.monotonic()
    cancel = core.ok("runs", "cancel", run["id"], "--reason", "acceptance")
    done = core.wait_run(run["id"], lambda r: r["state"] == "cancelled", "cancelled", 10)
    seconds = time.monotonic() - start
    assert seconds < 10.0
    assert cancel["action"]["outcome"] == "accepted"
    assert done["terminal"]
    assert states(core.events(run["id"])) == ["queued", "running", "cancelling", "cancelled"]
    assert core.ok("runs", "result", run["id"])["state"] == "cancelled"
    assert branch_files(repo, run["id"]) == [], "a cancelled run leaves no branch"
    again = core.cli("runs", "cancel", run["id"], "--json")
    assert again.rc == 1, "a finished run cannot be cancelled"
    assert again.error_code() == "conflict", "a finished run cannot be cancelled"
    record("mock.cancel", seconds=round(seconds, 3))


def test_dispatch_is_denied_by_default_and_a_second_run_in_a_repository_is_accepted(
    core: Core,
) -> None:
    repo = core.add_repo()
    stranger = core.cli(
        *("runs", "submit", "--agent", f"{AGENT}2", "--harness", "stub"),
        *("--repo", str(repo), "--task", "hang", "--json"),
    )
    assert stranger.rc == 1
    assert stranger.error_code() == "denied"
    assert core.ok("runs", "list")["runs"] == [], "a denied submit creates no run"

    run, _ = core.submit("stub", repo, "hang")
    second = core.cli(
        *("runs", "submit", "--agent", AGENT, "--harness", "stub"),
        *("--repo", str(repo), "--task", "hang", "--json"),
    )
    # t8 removed the busy rule: with no limit configured a second run in one repository is accepted.
    assert second.rc == 0, second.err
    second_run = second.json()["run"]
    assert second_run["id"] != run["id"]
    assert second_run["repo"] == run["repo"]
    other_harness = core.cli(
        *("runs", "submit", "--agent", AGENT, "--harness", "claude-code"),
        *("--repo", str(repo), "--task", "hang", "--json"),
    )
    assert (
        other_harness.rc == 1
    ), "the allow-list names the harness too: an entry for stub does not permit claude-code"
    assert (
        other_harness.error_code() == "denied"
    ), "the allow-list names the harness too: an entry for stub does not permit claude-code"
    core.ok("runs", "cancel", run["id"])
    core.ok("runs", "cancel", second_run["id"])


def test_a_run_needs_no_chat_server_and_no_network(core: Core) -> None:
    """The core and its worker hold no TCP socket at all while a run is steered and cancelled."""
    assert core.proc is not None
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, "hang")
    core.wait_run(run["id"], lambda r: r["state"] == "running", "running", 10)
    core.ok("runs", "steer", run["id"], "still there?")
    pids = [core.proc.pid, *core.worker_pids()]
    assert len(pids) == 2, "one daemon and one worker"
    sockets = {pid: netcheck.tcp_sockets(pid) for pid in pids}
    assert sockets == {pid: [] for pid in pids}, f"unexpected TCP sockets: {sockets}"
    assert not (core.root / ".culture").exists(), "no mesh configuration is readable"
    core.ok("runs", "cancel", run["id"])
    assert core.wait_terminal(run["id"], 10)["state"] == "cancelled"
    record("mock.no_chat", tcp_sockets=0, chat_servers_on_host=len(netcheck.chat_servers()))


def test_after_kill_9_and_restart_every_run_reports_a_state_and_none_invents_success(
    core: Core,
) -> None:
    """Four runs in four fates: finished, still working, hung with a live worker, worker killed."""
    repos = [core.add_repo() for _ in range(4)]
    finished, _ = core.submit("stub", repos[0], "files: done.txt")
    assert core.wait_terminal(finished["id"], 20)["state"] == "succeeded"
    working, _ = core.submit("stub", repos[1], LONG)
    hung, _ = core.submit("stub", repos[2], "hang")
    orphan, _ = core.submit("stub", repos[3], "hang")
    for run in (working, hung, orphan):
        core.wait_run(run["id"], lambda r: r["state"] == "running", "running", 10)
    orphan_pid = core.show(orphan["id"])["worker_pid"]
    hung_pid = core.show(hung["id"])["worker_pid"]

    core.kill9()
    os.kill(orphan_pid, signal.SIGKILL)
    wait_for("the orphan's worker to die", lambda: orphan_pid not in core.worker_pids(), 5)
    down = core.cli("runs", "list", "--json")
    assert down.rc == 2, "no core: exit 2, not a guess"
    assert down.error_code() == "unavailable", "no core: exit 2, not a guess"

    core.start()
    submitted = {finished["id"], working["id"], hung["id"], orphan["id"]}
    listed = {r["id"]: r for r in core.ok("runs", "list")["runs"]}
    assert set(listed) == submitted, "100% of submitted runs are reported"
    assert all(r["state"] in STATES for r in listed.values())
    assert listed[finished["id"]]["state"] == "succeeded"
    assert listed[working["id"]]["state"] == "running", "the surviving worker is still at work"
    # Reattach runs beside reads: a listing right after the restart may come before it is done.
    # A control call waits for it; a read is given a bounded moment here.
    core.wait_run(working["id"], lambda r: r["live_control"], "reattached to the survivor", 10)
    assert listed[orphan["id"]]["state"] == "unknown", "a dead worker is unknown, never succeeded"
    assert listed[hung["id"]]["state"] == "running"
    core.wait_run(hung["id"], lambda r: r["live_control"], "reattached to the survivor", 10)
    assert hung_pid in core.worker_pids(), "the restart did not signal the surviving worker"
    # D1 refused this as `unsupported`; since D2 (plan task t9) a restarted core takes back
    # live control of a worker that survived it.
    steer = core.cli("runs", "steer", hung["id"], "hello?", "--json")
    assert steer.rc == 0, f"live control after a restart: {steer}"

    # The surviving worker finishes on its own, and its success is backed by its commits.
    assert core.wait_terminal(working["id"], 60)["state"] == "succeeded"
    assert len(branch_files(repos[1], working["id"])) == 121, "README and all 120 files"
    succeeded = [r for r in core.ok("runs", "list")["runs"] if r["state"] == "succeeded"]
    by_repo = {str(r): r for r in repos}
    invented = 0
    for run in succeeded:
        recorded = states(core.events(run["id"]))[-1] == "succeeded"
        commits = core.ok("runs", "result", run["id"])["commits"]
        on_host = len(branch_files(by_repo[run["repo"]], run["id"])) > 1
        invented += not (recorded and commits and on_host)
    assert invented == 0, "every success is a recorded event with its commits on the host"
    assert {r["id"] for r in succeeded} == {finished["id"], working["id"]}
    assert branch_files(repos[3], orphan["id"]) == []
    record(
        "mock.restart",
        submitted=len(submitted),
        reported=len(listed),
        states=sorted(r["state"] for r in core.ok("runs", "list")["runs"]),
        invented_success=invented,
    )


def test_without_a_core_the_cli_exits_2_and_guesses_nothing() -> None:
    """The CLI's only path to a run is the socket: with no core there is no answer, only exit 2."""
    res = subprocess.run(  # nosec B603
        [sys.executable, "-m", "culture_agents", "runs", "list", "--json"],
        env={**os.environ, "CULTURE_AGENTS_SOCKET": "/nonexistent/core.sock"},
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 2
    assert res.stdout == ""
    assert "unavailable" in res.stderr


def test_a_2_0_client_is_refused_by_the_3_2_core_with_exit_2_naming_both_versions(
    core: Core,
) -> None:
    """The real core and the real CLI code, with the client's version set back to 2.0."""
    assert core.ok("runs", "list") == {"runs": []}  # this client and this core agree on 3.2
    old_client = (
        "import sys; from culture_agents.cli import _client, main; "
        "_client.CLIENT_API_VERSION = '2.0'; sys.exit(main(sys.argv[1:]))"
    )
    for argv in (["runs", "list"], ["agents", "list"], ["runs", "list", "--json"]):
        res = subprocess.run(  # nosec B603
            [sys.executable, "-c", old_client, *argv],
            env=core.env,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert res.returncode == 2, res.stderr
        assert res.stdout == ""
        assert "2.0" in res.stderr, res.stderr
        assert "3.2" in res.stderr, res.stderr
    detail = json.loads(res.stderr)  # the last one ran with --json
    assert (detail["client_api_version"], detail["server_api_version"]) == ("2.0", "3.2")
    assert core.show_version_refusal("2.0") == ("incompatible_version", "2.0", "3.2", 412)
    record("mock.version_refusal", client="2.0", core="3.2", exit_code=2)
