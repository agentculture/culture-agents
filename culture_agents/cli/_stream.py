"""The ``attach`` event stream: SSE parsing, the cursor rule and reconnecting.

``contract/README.md`` ("Events, cursor and replay"): the first event of a run
has cursor 1 and each next one is exactly one higher; to reconnect, a client
attaches again with ``after`` set to the last cursor it received.

What :func:`follow` does when something goes wrong:

* **The first connect fails**, or the core refuses the first stream: the error
  is raised at once (``unavailable`` is exit 2). Nothing is retried, because
  nothing has been followed yet.
* **The stream breaks after it opened once**: it is reopened at once with
  ``after`` set to the last cursor received.
* **The core is gone when reopening** (the connection fails, or the core
  answers the retryable ``unavailable``): the reopen is retried with a backoff
  of 0.2 s, 0.5 s, 1 s, then 2 s between attempts. The outage ends when a
  stream opens again. If none does within *reconnect_window* seconds (30 by
  default), ``unavailable`` is raised, naming the last cursor received.
* **Any other error on a reopen** (``not_found``, ``invalid``,
  ``incompatible_version``, ``internal``) is raised at once.
* **The stream keeps opening and closing without an event**: the sixth such
  stream in a row raises ``unavailable``, unless the run turns out to be
  terminal with nothing left to send, which ends the attach normally.

Within a stream, an event whose cursor was already received is skipped, and a
cursor that is not exactly the last one plus one is a server fault, raised as
``internal`` naming both cursors. An empty ``data:`` block is a keepalive.
"""

from __future__ import annotations

import http.client
import time
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from culture_agents.cli import _contract
from culture_agents.cli._client import (
    _describe,
    _internal,
    _loads,
    _query,
    _unavailable,
    error_from_body,
)
from culture_agents.cli._errors import EXIT_ENV_ERROR, CoreError

if TYPE_CHECKING:
    from culture_agents.cli._client import CoreClient

_STREAM_TIMEOUT = 45.0  # the core sends a keepalive at least every 15 s
_MAX_STALLED_RECONNECTS = 5
_BACKOFF = (0.2, 0.5, 1.0, 2.0)  # seconds between reconnect attempts; the last one repeats
_TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled", "timed_out", "unknown"})


class _Outage:
    """One stretch of failed reconnects, bounded by the reconnect window."""

    def __init__(self, window: float) -> None:
        self.window = window
        self.since: float | None = None
        self.attempts = 0

    def over(self) -> None:
        self.since, self.attempts = None, 0

    def wait(self, err: CoreError, cursor: int) -> None:
        """Sleep before the next attempt, or raise when the window is used up."""
        now = time.monotonic()
        if self.since is None:
            self.since = now
        left = self.window - (now - self.since)
        if left <= 0:
            raise CoreError(
                code=EXIT_ENV_ERROR,
                message=(
                    f"lost the core while following the run and could not reconnect within "
                    f"{self.window:g} s (last event received: cursor {cursor}): {err.raw_message}"
                ),
                remediation=(
                    "check that the core is running, then resume with "
                    f"'agents runs attach <run_id> --after {cursor}'"
                ),
                error_code="unavailable",
            ) from err
        delay = _BACKOFF[min(self.attempts, len(_BACKOFF) - 1)]
        self.attempts += 1
        time.sleep(min(delay, left))


def follow(
    client: CoreClient, run_id: str, after: int, *, reconnect_window: float
) -> Iterator[dict[str, Any]]:
    """Yield the events of *run_id* after cursor *after*, each exactly once, to the terminal one."""
    client.connect()
    route = f"/v1/runs/{quote(run_id, safe='')}"
    cursor, stalled, opened_once = after, 0, False
    outage = _Outage(reconnect_window)
    while True:
        try:
            conn, resp = _open_stream(client, f"{route}/attach{_query({'after': cursor})}")
        except CoreError as err:
            _wait_out(err, outage, cursor, retryable=opened_once)
            continue
        opened_once = True
        outage.over()
        before = cursor
        try:
            for event in _new_events(resp, cursor):
                cursor = event["cursor"]
                yield event
                if _is_terminal(event):
                    return
        except (OSError, http.client.HTTPException):
            pass  # a broken stream is reopened below
        finally:
            conn.close()
        if cursor != before:
            stalled = 0
            continue
        stalled += 1
        if _finished_after_empty_stream(client, route, cursor, stalled, outage):
            return


def _wait_out(err: CoreError, outage: _Outage, cursor: int, *, retryable: bool = True) -> None:
    """Wait before the next attempt when the core is merely gone; raise any other error."""
    if not retryable or err.error_code != "unavailable":
        raise err
    outage.wait(err, cursor)


def _new_events(resp: http.client.HTTPResponse, cursor: int) -> Iterator[dict[str, Any]]:
    """The events of one stream after *cursor*: duplicates skipped, a gap raised as ``internal``."""
    for event in parse_sse(resp):
        if event["cursor"] <= cursor:
            continue  # already received: a duplicate is skipped
        if event["cursor"] != cursor + 1:
            raise _internal(
                f"the core sent the event with cursor {event['cursor']} right after "
                f"cursor {cursor}: events are missing from the stream"
            )
        cursor = event["cursor"]
        yield event


def _finished_after_empty_stream(
    client: CoreClient, route: str, cursor: int, stalled: int, outage: _Outage
) -> bool:
    """After the *stalled*-th stream in a row without an event: is the run over?

    True when the run is terminal with nothing left to send. Otherwise waits
    before the next reopen and returns False, or raises when the stream has
    stalled too often.
    """
    if stalled > _MAX_STALLED_RECONNECTS:
        raise _unavailable(client.path, "the event stream keeps closing without events")
    try:
        run = client._json("GET", route, "run")
    except CoreError as err:
        _wait_out(err, outage, cursor)
        return False
    if run["terminal"] and run["cursor"] <= cursor:
        return True  # already finished and fully replayed: nothing more to send
    time.sleep(min(0.2 * stalled, 1.0))
    return False


def _open_stream(
    client: CoreClient, route: str
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    """Open the stream; a failed connect or a non-200 answer is raised as its ``CoreError``."""
    conn, resp = client._open("GET", route, timeout=_STREAM_TIMEOUT)
    if resp.status == 200:
        return conn, resp
    try:
        raw = resp.read()
    except (OSError, http.client.HTTPException) as exc:
        raise _unavailable(client.path, _describe(exc)) from exc
    finally:
        conn.close()
    raise error_from_body(resp.status, _loads(raw))


def _is_terminal(event: dict[str, Any]) -> bool:
    return event["kind"] == "run.state" and event["data"].get("to") in _TERMINAL_STATES


def parse_sse(resp: http.client.HTTPResponse) -> Iterator[dict[str, Any]]:
    """Parse ``id:/event:/data:`` messages separated by blank lines into valid events.

    Comment lines (``: keepalive``) and messages with an empty ``data`` are
    keepalives and are skipped. The payload is the ``data`` JSON, whose own
    ``kind`` and ``cursor`` are authoritative; it must validate against
    ``event.json`` or the stream ends with an ``internal`` error.
    """
    data_lines: list[str] = []
    while True:
        line = resp.readline()
        if not line:
            return  # EOF; a half-received message is dropped and replayed on reconnect
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if text == "":
            payload = "\n".join(data_lines)
            data_lines = []
            if not payload.strip():
                continue
            event = _loads(payload.encode("utf-8"))
            found = _contract.problem("event", event)
            if found:
                raise _internal(f"the core sent an invalid event ({found})")
            yield event
        elif text.startswith("data:"):
            data_lines.append(text[5:].removeprefix(" "))
