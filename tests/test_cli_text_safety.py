"""Text mode shows control characters from a run; ``--json`` stays exact; rendering never raises."""

from __future__ import annotations

import copy
import json

import pytest

from culture_agents.cli import _render
from culture_agents.cli._text import visible
from tests.cli_support import run
from tests.fake_core import RUN_ID, fixture, sse_frame, stream_events

HOSTILE = "ok\x1b[2J\x1b]0;owned\x07\nfake #9 line\r\x00\x7f\x9b31m\u2028end"
RAW = set("\x1b\x07\r\x00\x7f\x9b\u2028")


def _clean(text: str) -> bool:
    return not (RAW & set(text))


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("\x1b[31m", "\\x1b[31m"),
        ("a\nb", "a\\nb"),
        ("a\r\n\tb", "a\\r\\n\\tb"),
        ("\x00\x07\x1f", "\\x00\\x07\\x1f"),
        ("\x7f", "\\x7f"),
        ("\x80\x9b\x9f", "\\x80\\x9b\\x9f"),
        ("\u2028\u2029", "\\u2028\\u2029"),
        ("\ud800", "\\ud800"),
    ],
)
def test_control_characters_are_shown_not_sent(raw: str, shown: str) -> None:
    assert visible(raw) == shown


def test_ordinary_text_is_untouched() -> None:
    text = "héllo wörld — 日本語 🙂 C:\\path \u00a0 \u00e9"
    assert visible(text) == text
    assert visible(7) == "7" and visible(None) == "None"


def _output_event(text: str) -> dict:
    event = copy.deepcopy(stream_events()[2])
    event["data"]["text"] = text
    return event


def test_event_line_is_one_safe_line() -> None:
    line = _render.event_line(_output_event(HOSTILE))
    assert "\n" not in line and _clean(line)
    assert "ok\\x1b[2J\\x1b]0;owned\\x07\\nfake #9 line\\r\\x00\\x7f\\x9b31m\\u2028end" in line


def test_every_event_kind_renders_safely() -> None:
    state = copy.deepcopy(fixture("event", "root.state-cancelling-deadline"))
    state["data"]["reason"] = HOSTILE
    error = copy.deepcopy(fixture("event", "root.error-fatal"))
    error["data"]["error"]["message"] = HOSTILE
    control = copy.deepcopy(fixture("event", "root.control-steer"))
    control["data"]["action"]["id"] = HOSTILE
    refused = copy.deepcopy(fixture("event", "root.refused-steer-unsupported"))
    refused["data"]["action"]["error"]["message"] = HOSTILE
    for event in (state, error, control, refused):
        line = _render.event_line(event)
        assert "\n" not in line and _clean(line), line
        assert "\\x1b[2J" in line, line


def test_run_views_escape_what_came_from_the_run() -> None:
    run_payload = {**fixture("run", "root.failed"), "task": HOSTILE, "state_reason": HOSTILE}
    detail = str(_render.run_detail(run_payload))
    assert _clean(detail) and len(detail.splitlines()) == 15
    result = copy.deepcopy(fixture("run", "run_result.failed"))
    result["summary"] = HOSTILE
    result["error"]["message"] = HOSTILE
    text = str(_render.run_result(result))
    assert _clean(text) and len(text.splitlines()) == 7
    doc = copy.deepcopy(fixture("capabilities", "root.opencode-no-steer"))
    doc["capabilities"]["steer"]["reason"] = HOSTILE
    doc["version"] = HOSTILE
    assert all("\n" not in line and _clean(line) for line in _render.capability_lines(doc))


def test_logs_text_is_escaped_and_json_is_exact(core, capsys) -> None:
    page = fixture("event", "event_page.first-page")
    page = {**page, "events": [_output_event(HOSTILE)]}
    core.respond("GET /v1/runs/{id}/events", 200, page)
    text = run(capsys, "runs", "logs", RUN_ID)
    assert text.rc == 0 and _clean(text.out)
    assert len(text.out.splitlines()) == 2  # the event, then the "more events" line
    assert run(capsys, "runs", "logs", RUN_ID, "--json").json() == page


def test_attach_text_is_escaped_and_json_is_exact(core, capsys) -> None:
    events = stream_events()
    hostile = [_output_event(HOSTILE) if e["cursor"] == 3 else e for e in events]
    stream = b"".join(sse_frame(e) for e in hostile)
    core.attach_cutoffs = [stream, stream]
    text = run(capsys, "runs", "attach", RUN_ID)
    assert text.rc == 0 and _clean(text.out)
    assert len(text.out.splitlines()) == len(events)
    j = run(capsys, "runs", "attach", RUN_ID, "--json")
    assert len(j.out.splitlines()) == len(events)  # one object per line for any line reader
    assert [json.loads(line) for line in j.out.split("\n") if line] == hostile  # exact data


def test_json_line_is_exact_data_on_one_line() -> None:
    from culture_agents.cli._text import json_line

    payload = {"text": HOSTILE + "\ud800 é 日本"}
    line = json_line(payload)
    assert json.loads(line) == payload
    assert len(line.splitlines()) == 1 and "é 日本" in line
    line.encode("utf-8")  # a lone surrogate no longer breaks the write


def test_show_and_result_text_are_escaped_and_json_is_exact(core, capsys) -> None:
    payload = {**fixture("run", "root.running"), "task": HOSTILE}
    core.respond("GET /v1/runs/{id}", 200, payload)
    assert _clean(run(capsys, "runs", "show", RUN_ID).out)
    assert run(capsys, "runs", "show", RUN_ID, "--json").json() == payload
    result = {**fixture("run", "run_result.succeeded"), "summary": HOSTILE}
    core.respond("GET /v1/runs/{id}/result", 200, result)
    assert _clean(run(capsys, "runs", "result", RUN_ID).out)
    assert run(capsys, "runs", "result", RUN_ID, "--json").json() == result


def test_a_core_error_message_is_escaped_in_text_and_exact_in_json(core, capsys) -> None:
    body = copy.deepcopy(fixture("error", "root.conflict"))
    body["error"]["message"] = "state is \x1b[2Jqueued\nhint: run rm -rf"
    core.respond("GET /v1/runs/{id}/result", 409, body)
    text = run(capsys, "runs", "result", RUN_ID)
    assert text.rc == 1 and _clean(text.err)
    assert text.err.count("\nhint: ") == 1  # the message could not forge a second hint line
    j = run(capsys, "runs", "result", RUN_ID, "--json")
    assert j.err_json()["message"] == "conflict: " + body["error"]["message"]


# --- rendering never raises ----------------------------------------------------

JUNK = [None, 0, True, "x", [], [None], {}, {"capabilities": []}, {"capabilities": {"steer": "y"}}]
RENDERERS = [
    _render.capability_lines,
    _render.agent_lines,
    _render.agent_list,
    _render.run_line,
    _render.run_detail,
    _render.run_list,
    _render.submitted,
    _render.accepted,
    _render.run_result,
    _render.event_line,
    _render.event_page,
]


@pytest.mark.parametrize("renderer", RENDERERS, ids=lambda f: f.__name__)
@pytest.mark.parametrize("junk", JUNK, ids=repr)
def test_no_renderer_raises_on_odd_input(renderer, junk) -> None:
    out = renderer(junk)
    assert isinstance(out if isinstance(out, list) else str(out), (str, list))


def test_malformed_capability_entries_are_rendered_not_raised() -> None:
    doc = {
        "harness": "x",
        "available": "maybe",
        "capabilities": {"steer": "yes", "cancel": None, "submit": ["a"], "stream": {"caveats": 3}},
    }
    lines = _render.capability_lines(doc)
    assert len(lines) == 5 and lines[0].startswith("harness x")
    assert _render.agent_status(None, [None, "x", doc])  # the status view takes the same input
    for junk in ({"events": "x", "more": 1}, {"events": [1, None]}, {"runs": [1, {"id": []}]}):
        assert str(_render.event_page(junk)) and str(_render.run_list(junk))
