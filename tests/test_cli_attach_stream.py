"""``attach``: reconnecting across a core restart, and the SSE parser's edge cases."""

from __future__ import annotations

import pytest

from culture_agents.cli import _stream
from culture_agents.cli._client import CoreClient
from culture_agents.cli._errors import CoreError
from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture, sse_frame, stream_events

EVENTS = stream_events()
CURSORS = [e["cursor"] for e in EVENTS]
UNAVAILABLE = (503, fixture("error", "root.unavailable"))


def _frames(*events: dict) -> bytes:
    return b"".join(sse_frame(e) for e in events)


def _afters(core) -> list[str]:
    return [r["query"]["after"] for r in core.seen("GET", f"/v1/runs/{RUN_ID}/attach")]


@pytest.fixture
def naps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record the client's backoff waits instead of sleeping."""
    taken: list[float] = []
    monkeypatch.setattr(_stream.time, "sleep", taken.append)
    return taken


# --- reconnect -----------------------------------------------------------------


def test_attach_resumes_after_the_core_went_away_and_came_back(core, monkeypatch) -> None:
    naps: list[float] = []

    def nap(seconds: float) -> None:
        naps.append(seconds)
        if len(naps) == 3:
            core.start()  # the core is back after the third wait

    monkeypatch.setattr(_stream.time, "sleep", nap)
    core.attach_cutoffs = [2]
    stream = CoreClient().attach(RUN_ID)
    got = [next(stream)["cursor"], next(stream)["cursor"]]
    core.stop()
    got += [event["cursor"] for event in stream]
    assert got == CURSORS  # no gap, no duplicate
    assert _afters(core) == ["0", "2"]
    assert len(naps) == 3 and all(0 < n <= 2 for n in naps) and naps[0] < naps[2]


def test_attach_gives_up_when_the_core_stays_away_for_the_whole_window(core, naps) -> None:
    core.attach_cutoffs = [2]
    stream = CoreClient().attach(RUN_ID, reconnect_window=0.05)
    assert [next(stream)["cursor"], next(stream)["cursor"]] == [1, 2]
    core.stop()
    with pytest.raises(CoreError) as exc:
        next(stream)
    assert (exc.value.code, exc.value.error_code) == (2, "unavailable")
    assert "cursor 2" in exc.value.message
    assert naps  # it waited between attempts instead of spinning


def test_a_retryable_unavailable_answer_is_retried_after_the_stream_started(core, naps) -> None:
    core.attach_cutoffs = [3, UNAVAILABLE, UNAVAILABLE, None]
    assert [e["cursor"] for e in CoreClient().attach(RUN_ID)] == CURSORS
    assert _afters(core) == ["0", "3", "3", "3"]
    assert len(naps) == 2


@pytest.mark.parametrize(
    ("name", "status", "code", "exit_code"),
    [
        ("root.not-found", 404, "not_found", 1),
        ("root.invalid-with-field", 400, "invalid", 1),
        ("root.incompatible-version", 412, "incompatible_version", 2),
    ],
)
def test_a_non_retryable_error_on_reconnect_ends_the_attach_at_once(
    core, naps, name, status, code, exit_code
) -> None:
    core.attach_cutoffs = [2, (status, fixture("error", name))]
    stream = CoreClient().attach(RUN_ID)
    assert [next(stream)["cursor"], next(stream)["cursor"]] == [1, 2]
    with pytest.raises(CoreError) as exc:
        next(stream)
    assert (exc.value.error_code, exc.value.code) == (code, exit_code)
    assert naps == [] and len(_afters(core)) == 2


def test_a_first_connect_that_fails_exits_2_at_once(no_core, naps, capsys) -> None:
    r = run(capsys, "runs", "attach", RUN_ID)
    assert r.rc == 2 and r.err.startswith("error: cannot reach the core")
    assert naps == []


def test_a_first_stream_that_is_refused_as_unavailable_is_not_retried(core, naps, capsys) -> None:
    core.attach_cutoffs = [UNAVAILABLE]
    r = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert r.rc == 2 and r.err_json()["error_code"] == "unavailable"
    assert naps == [] and len(_afters(core)) == 1


def test_attach_through_the_cli_survives_a_restart(core, monkeypatch, capsys) -> None:
    def nap(_seconds: float) -> None:
        if core.socket_path.exists() is False:
            core.start()

    monkeypatch.setattr(_stream.time, "sleep", nap)
    core.attach_cutoffs = [2]
    core.stop_after_attach = True  # the core dies right after the first stream breaks
    r = run(capsys, "runs", "attach", RUN_ID)
    assert r.rc == 0 and r.err == ""
    assert [line.split()[0] for line in r.out.splitlines()] == [f"#{c}" for c in CURSORS]


# --- the SSE parser ------------------------------------------------------------


def test_an_empty_data_block_is_a_keepalive(core) -> None:
    body = b"data:\n\n" + _frames(*EVENTS[:2]) + b"data: \n\nevent: ping\ndata:\n\n"
    core.attach_cutoffs = [body + _frames(*EVENTS[2:])]
    assert [e["cursor"] for e in CoreClient().attach(RUN_ID)] == CURSORS


def test_a_duplicate_cursor_is_skipped(core) -> None:
    core.attach_cutoffs = [_frames(EVENTS[0], EVENTS[1], EVENTS[1], EVENTS[0], *EVENTS[2:])]
    assert [e["cursor"] for e in CoreClient().attach(RUN_ID)] == CURSORS


def test_a_replayed_cursor_after_a_resume_is_skipped(core) -> None:
    core.attach_cutoffs = [_frames(*EVENTS[2:])]  # the core resends event 3 after ?after=3
    assert [e["cursor"] for e in CoreClient().attach(RUN_ID, 3)] == CURSORS[3:]


@pytest.mark.parametrize(
    ("after", "sent", "last", "bad"), [(0, (0, 2), 1, 3), (3, (4,), 3, 5), (0, (1,), 0, 2)]
)
def test_a_cursor_gap_is_an_internal_error_naming_both_cursors(
    core, capsys, after, sent, last, bad
) -> None:
    core.attach_cutoffs = [_frames(*(EVENTS[i] for i in sent))]
    r = run(capsys, "runs", "attach", RUN_ID, "--after", str(after), "--json")
    assert r.rc == 2
    err = r.err_json()
    assert err["error_code"] == "internal"
    assert f"cursor {bad}" in err["message"] and f"cursor {last}" in err["message"]
    assert len(r.out.splitlines()) == len(sent) - 1  # nothing at or past the gap is printed


def test_data_that_is_not_json_is_an_internal_error(core, capsys) -> None:
    core.attach_cutoffs = [_frames(EVENTS[0]) + b"data: not json\n\n"]
    r = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert r.rc == 2 and r.err_json()["error_code"] == "internal"
