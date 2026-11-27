"""``agents runs submit|list|show|attach|steer|cancel|answer|logs|result``.

Every verb is one or two calls on the core's control socket. The CLI never
decides what the core may do: ``pause``, ``resume``, sessions,
delegation and placement are not verbs here, and a request the core refuses
(``unsupported``, ``denied``, ``limit_reached``) surfaces as that typed error.

Task text and steer messages are data sent verbatim, never interpreted.
"""

from __future__ import annotations

import os
import sys
import uuid
from typing import Any
from urllib.parse import quote

from agentfront import Flag

from culture_agents.cli import _mode, _render, _text
from culture_agents.cli._client import CoreClient
from culture_agents.cli._errors import EXIT_USER_ERROR, CliError, CoreError
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
        help="repeat-safe key (default: generated and printed); a repeat takes effect once",
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


ANSWER_FLAGS = (
    Flag(names=("--question",), dest="question", required=True, help="the question id to answer"),
    Flag(names=("--answer",), dest="answer", help="free-text answer (sent verbatim)"),
    Flag(names=("--choice",), dest="choice", help="chosen choice ids, comma separated"),
    Flag(names=("--decision",), dest="decision", choices=("approve", "deny"), help="for approvals"),
    *CALLER_FLAGS,
)


def _run_route(run_id: str) -> str:
    return f"/v1/runs/{quote(run_id, safe='')}"


def _principal(client: CoreClient, caller: str | None, kind: str | None) -> dict[str, str]:
    return {"kind": kind or "operator", "id": caller or f"{client.node}-operator"}


def _key(given: str | None) -> tuple[str, bool]:
    """The idempotency key to send, and whether the CLI generated it."""
    return (given, False) if given else (f"cli-{uuid.uuid4().hex}", True)


def _keyed(done: Rendered, key: str, generated: bool) -> Rendered:
    """Show the key: always in ``--json``, and in text when the CLI made it up."""
    text = f"{done}\nidempotency key: {key} (generated; repeat the verb with it to retry)"
    return Rendered(dict(done, idempotency_key=key), text if generated else str(done))


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
    key, generated = _key(idempotency_key)
    body = _drop_none(
        {
            "agent_id": agent,
            "harness": harness,
            "repo": os.path.abspath(repo) if repo else repo,
            "task": task,
            "caller": _principal(client, caller, caller_kind),
            "idempotency_key": key,
            "deadline": deadline,
            "session_id": session_id,
            "parent_run_id": parent_run_id,
        }
    )
    sent = client.post_keyed("/v1/runs", "submit_response", body)
    return _keyed(_render.submitted(sent), key, generated)


def runs_list(
    state: str | None = None, agent: str | None = None, limit: int | None = None
) -> Rendered:
    """List runs, newest first."""
    query = {"state": state, "agent_id": agent, "limit": limit}
    client = CoreClient()
    runs = client.get("/v1/runs", "run_list", query)
    return _render.run_list(runs, client.get("/v1/runs/unreadable", "unreadable_list"))


def runs_unreadable() -> Rendered:
    """List the run directories the core cannot read, with the reason for each."""
    return _render.unreadable_list(CoreClient().get("/v1/runs/unreadable", "unreadable_list"))


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
    key, generated = _key(idempotency_key)
    body = {
        "caller": _principal(client, caller, caller_kind),
        "message": message,
        "idempotency_key": key,
    }
    route = _run_route(run_id) + "/steer"
    return _keyed(
        _render.accepted(client.post_keyed(route, "accepted_response", body)), key, generated
    )


def runs_cancel(
    run_id: str,
    reason: str | None = None,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Cancel a run; it moves to cancelling, then a terminal state."""
    client = CoreClient()
    key, generated = _key(idempotency_key)
    body = _drop_none(
        {
            "caller": _principal(client, caller, caller_kind),
            "reason": reason,
            "idempotency_key": key,
        }
    )
    route = _run_route(run_id) + "/cancel"
    return _keyed(
        _render.accepted(client.post_keyed(route, "accepted_response", body)), key, generated
    )


def runs_answer(
    run_id: str,
    question: str | None = None,
    answer: str | None = None,
    choice: str | None = None,
    decision: str | None = None,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Answer one pending question of a run. Sent once: the core does not replay an answer."""
    if answer is None and not choice and decision is None:
        raise CliError(
            code=EXIT_USER_ERROR,
            message="give --answer, --choice or --decision",
            remediation="see 'agents explain runs answer'; pending questions are in 'runs show'",
        )
    client = CoreClient()
    body = _drop_none(
        {
            "caller": _principal(client, caller, caller_kind),
            "question_id": question,
            "answer": answer,
            "choice_ids": [c for c in choice.split(",") if c] if choice else None,
            "decision": decision,
            "idempotency_key": idempotency_key,
        }
    )
    try:
        sent = client.post(_run_route(run_id) + "/answer", "accepted_response", body)
    except CoreError as exc:
        exc.remediation = _ANSWER_HINTS.get(exc.error_code, exc.remediation)
        raise
    done = _render.accepted(sent)
    return _keyed(done, idempotency_key, False) if idempotency_key else done


_ANSWER_HINTS = {
    "conflict": (
        "an answer is never retried or replayed: the question already has its answer, or its "
        "time limit passed, or the run is not running; see 'agents runs show <run_id>'"
    ),
    "unsupported": (
        "this run's harness cannot ask or take answers (only the stub harness can today); "
        "see 'agents agents status <agent_id>'"
    ),
    "not_found": "check the run id and the question id: 'agents runs show <run_id>' lists them",
    "unavailable": (
        "the answer may or may not have been delivered: check 'agents runs show <run_id>' "
        "before answering again; it is not retried"
    ),
}


def runs_attach(run_id: str, after: int | None = None) -> None:
    """Follow a run's events live until it reaches a terminal state."""
    json_mode = _mode.JSON_MODE.get()
    for event in CoreClient().attach(run_id, after or 0):
        line = _text.json_line(event) if json_mode else _render.event_line(event)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
