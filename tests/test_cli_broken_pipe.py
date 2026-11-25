"""A reader that closes the pipe (``agents ... | head -1``) ends the CLI quietly with exit 0."""

from __future__ import annotations

import copy
import os
import subprocess
import sys

import pytest

from tests.fake_core import RUN_ID, fixture, stream_events

#: Far more than a pipe holds (64 KiB on Linux), so the CLI is still writing when the reader goes.
BIG = 400


def _big_events() -> list[dict]:
    template = stream_events()[2]
    events = []
    for cursor in range(1, BIG + 1):
        event = copy.deepcopy(template)
        event["cursor"] = cursor
        event["data"]["text"] = f"line {cursor} " + "x" * 2000
        events.append(event)
    return events


def _head_1(argv: list[str], socket_path: str) -> tuple[int, str, str]:
    """Run the CLI, read one line of its stdout, close the pipe, and wait for it."""
    env = {**os.environ, "CULTURE_AGENTS_SOCKET": socket_path}
    env.pop("PYTHONUNBUFFERED", None)  # keep stdout block-buffered, as under a real pipe
    proc = subprocess.Popen(
        [sys.executable, "-m", "culture_agents", *argv],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    assert proc.stdout is not None and proc.stderr is not None
    first = proc.stdout.readline().decode("utf-8")
    proc.stdout.close()
    err = proc.stderr.read().decode("utf-8")
    return proc.wait(timeout=30), first, err


@pytest.mark.parametrize("flags", [[], ["--json"]], ids=["text", "json"])
def test_attach_into_a_closed_pipe_exits_0_quietly(core, flags) -> None:
    core.events = _big_events()  # never terminal: only the closed pipe can end the attach
    rc, first, err = _head_1(["runs", "attach", RUN_ID, *flags], str(core.socket_path))
    assert first.strip()
    assert err == ""  # no "unexpected" error and no "Exception ignored" from the interpreter
    assert rc == 0


@pytest.mark.parametrize("flags", [[], ["--json"]], ids=["text", "json"])
def test_a_buffered_result_into_a_closed_pipe_exits_0_quietly(core, flags) -> None:
    page = {**fixture("event", "event_page.first-page"), "events": _big_events()}
    page["last_cursor"], page["more"] = BIG, False
    core.respond("GET /v1/runs/{id}/events", 200, page)
    rc, first, err = _head_1(["runs", "logs", RUN_ID, *flags], str(core.socket_path))
    assert first.strip()
    assert err == ""
    assert rc == 0


def test_a_reader_that_closes_before_anything_is_written_is_quiet_too(core) -> None:
    env = {**os.environ, "CULTURE_AGENTS_SOCKET": str(core.socket_path)}
    read_end, write_end = os.pipe()
    os.close(read_end)  # the pipe is already broken when the CLI starts
    try:
        done = subprocess.run(
            [sys.executable, "-m", "culture_agents", "runs", "list"],
            stdout=write_end,
            stderr=subprocess.PIPE,
            env=env,
            timeout=30,
        )
    finally:
        os.close(write_end)
    assert done.stderr == b""
    assert done.returncode == 0
