"""``agents runs submit|list|show|attach|steer|cancel|logs|result``.

Every verb is one or two calls on the core's control socket. The CLI never
decides what the core may do: ``pause``, ``resume``, ``answer``, sessions,
delegation and placement are not verbs here, and a request the core refuses
(``unsupported``, ``denied``, ``limit_reached``) surfaces as that typed error.

Task text and steer messages are data sent verbatim, never interpreted.
"""

from __future__ import annotations

import os
import sys
from typing import Any
from urllib.parse import quote

from agentfront import Flag

from culture_agents.cli import _mode, _render, _text
from culture_agents.cli._client import CoreClient
from culture_agents.cli._render import Rendered

_STATES = (
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "unanswered",
    "unknown",
)
_KINDS = ("operator", "agent")

CALLER_FLAGS = (
    Flag(
        names=("--caller",),
        dest="caller",
        help="mesh id recorded as the caller (default: <node>-operator)",
    ),
    Flag(
        names=("--caller-kind",),
        dest="caller_kind",
        choices=_KINDS,
        help="caller kind: operator (default) or agent",
    ),
    Flag(
        names=("--idempotency-key",),
        dest="idempotency_key",
        help="recorded and returned; the core does not deduplicate on it",
    ),
)

SUBMIT_FLAGS = (
    Flag(names=("--agent",), dest="agent", required=True, help="executing agent mesh id"),
    Flag(names=("--harness",), dest="harness", required=True, help="harness id, e.g. claude-code"),
    Flag(names=("--repo",), dest="repo", required=True, help="repository path on the core's host"),
    Flag(names=("--task",), dest="task", required=True, help="the work to do (sent verbatim)"),
    Flag(
        names=("--deadline",), dest="deadline", help="absolute UTC time, e.g. 2026-11-25T11:00:00Z"
    ),
    Flag(names=("--session-id",), dest="session_id", help="continue a session (core: unsupported)"),
    Flag(names=("--parent-run-id",), dest="parent_run_id", help="delegate (core: unsupported)"),
    *CALLER_FLAGS,
)
LIST_FLAGS = (
    Flag(names=("--state",), dest="state", choices=_STATES, help="only runs in this state"),
    Flag(names=("--agent",), dest="agent", help="only runs of this agent mesh id"),
    Flag(names=("--limit",), dest="limit", type=int, help="at most this many (1-500, default 50)"),
)
LOGS_FLAGS = (
    Flag(names=("--after",), dest="after", type=int, help="only events after this cursor"),
    Flag(names=("--limit",), dest="limit", type=int, help="at most this many (1-5000)"),
)
ATTACH_FLAGS = (
    Flag(names=("--after",), dest="after", type=int, help="resume after this cursor (default 0)"),
)
CANCEL_FLAGS = (
    Flag(names=("--reason",), dest="reason", help="why, recorded with the action"),
    *CALLER_FLAGS,
)


def _run_route(run_id: str) -> str:
    return f"/v1/runs/{quote(run_id, safe='')}"


def _principal(client: CoreClient, caller: str | None, kind: str | None) -> dict[str, str]:
    return {"kind": kind or "operator", "id": caller or f"{client.node}-operator"}


def _drop_none(body: dict[str, Any]) -> dict[str, Any]:
    """Optional request fields are omitted, never null (contract)."""
    return {k: v for k, v in body.items() if v is not None}


def runs_submit(
    agent: str | None = None,
    harness: str | None = None,
    repo: str | None = None,
    task: str | None = None,
    deadline: str | None = None,
    session_id: str | None = None,
    parent_run_id: str | None = None,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Submit a task to an agent; returns the queued run."""
    client = CoreClient()
    body = _drop_none(
        {
            "agent_id": agent,
            "harness": harness,
            "repo": os.path.abspath(repo) if repo else repo,
            "task": task,
            "caller": _principal(client, caller, caller_kind),
            "idempotency_key": idempotency_key,
            "deadline": deadline,
            "session_id": session_id,
            "parent_run_id": parent_run_id,
        }
    )
    return _render.submitted(client.post("/v1/runs", "submit_response", body))


def runs_list(
    state: str | None = None, agent: str | None = None, limit: int | None = None
) -> Rendered:
    """List runs, newest first."""
    query = {"state": state, "agent_id": agent, "limit": limit}
    return _render.run_list(CoreClient().get("/v1/runs", "run_list", query))


def runs_show(run_id: str) -> Rendered:
    """Show one run."""
    return _render.run_detail(CoreClient().get(_run_route(run_id), "run"))


def runs_logs(run_id: str, after: int | None = None, limit: int | None = None) -> Rendered:
    """Read a page of a run's stored events."""
    query = {"after": after, "limit": limit}
    return _render.event_page(CoreClient().get(_run_route(run_id) + "/events", "event_page", query))


def runs_result(run_id: str) -> Rendered:
    """Show the outcome of a finished run."""
    return _render.run_result(CoreClient().get(_run_route(run_id) + "/result", "run_result"))


def runs_steer(
    run_id: str,
    message: str,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Send a mid-run instruction to a running run."""
    client = CoreClient()
    body = _drop_none(
        {
            "caller": _principal(client, caller, caller_kind),
            "message": message,
            "idempotency_key": idempotency_key,
        }
    )
    return _render.accepted(client.post(_run_route(run_id) + "/steer", "accepted_response", body))


def runs_cancel(
    run_id: str,
    reason: str | None = None,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Cancel a run; it moves to cancelling, then a terminal state."""
    client = CoreClient()
    body = _drop_none(
        {
            "caller": _principal(client, caller, caller_kind),
            "reason": reason,
            "idempotency_key": idempotency_key,
        }
    )
    return _render.accepted(client.post(_run_route(run_id) + "/cancel", "accepted_response", body))


def runs_attach(run_id: str, after: int | None = None) -> None:
    """Follow a run's events live until it reaches a terminal state."""
    json_mode = _mode.JSON_MODE.get()
    for event in CoreClient().attach(run_id, after or 0):
        line = _text.json_line(event) if json_mode else _render.event_line(event)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
