"""``agents runs submit|list|show|attach|steer|cancel|answer|logs|result``.

Every verb is one or two calls on the core's control socket. The CLI never
decides what the core may do: ``pause``, ``resume``, sessions and
delegation are not verbs here, and a request the core refuses
(``unsupported``, ``denied``, ``limit_reached``) surfaces as that typed error.

A run on another fleet member (API 3.2): ``submit --alias`` sends the run to
the member that the node of ``--agent`` names, through this core, which calls
it over the fleet transport. The caller chooses the member; nothing schedules.
The repository is the alias that member defines, the deadline a duration
(``--deadline-in``), and the base commit the HEAD of the checkout the CLI runs
in unless ``--base`` or ``--no-base`` says otherwise. ``show``, ``attach``,
``steer``, ``cancel`` and (API 3.3) ``logs`` and ``result`` reach the member
that a run id's node names; ``result`` also brings the run's branch into the
caller's checkout from a git bundle (``_fetch``).

Task text and steer messages are data sent verbatim, never interpreted.
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from agentfront import Flag

from culture_agents.cli import _fetch, _mode, _render, _text
from culture_agents.cli._client import CoreClient
from culture_agents.cli._errors import EXIT_USER_ERROR, CliError, CoreError
from culture_agents.cli._remote import check_submit, remote_base, usage
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
    Flag(names=("--repo",), dest="repo", help="repository path on this core's host"),
    Flag(
        names=("--alias",),
        dest="alias",
        help="repository alias the executing member defines (runs on the member --agent names)",
    ),
    Flag(names=("--task",), dest="task", required=True, help="the work to do (sent verbatim)"),
    Flag(
        names=("--deadline",), dest="deadline", help="absolute UTC time, e.g. 2026-11-25T11:00:00Z"
    ),
    Flag(
        names=("--deadline-in",),
        dest="deadline_in",
        type=int,
        help="seconds the run may take, counted on the executing core's clock",
    ),
    Flag(
        names=("--base",),
        dest="base",
        help="with --alias: the commit to start from (default: HEAD of this checkout)",
    ),
    Flag(
        names=("--no-base",),
        dest="no_base",
        action="store_true",
        help="with --alias: name no commit; the run starts from the member's HEAD",
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
RESULT_FLAGS = (
    Flag(
        names=("--into",),
        dest="into",
        help="run on another member: the checkout to fetch its branch into (default: this one)",
    ),
    Flag(
        names=("--no-fetch",),
        dest="no_fetch",
        action="store_true",
        help="run on another member: show the result only, fetch nothing",
    ),
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


def _submit_remote(client: CoreClient, body: dict[str, Any], key: str, generated: bool) -> Rendered:
    """``POST /v1/fleet/runs``: this core sends the submit to the member the agent id names."""
    sent = client.post_keyed("/v1/fleet/runs", "remote_submit_response", _drop_none(body))
    done = _render.submitted(sent)
    text = f"{done}\nbase commit: {_text.visible(sent['run']['base_commit'])}"
    return _keyed(Rendered(dict(done), text), key, generated)


def runs_submit(
    agent: str | None = None,
    harness: str | None = None,
    repo: str | None = None,
    alias: str | None = None,
    task: str | None = None,
    deadline: str | None = None,
    deadline_in: int | None = None,
    base: str | None = None,
    no_base: bool = False,
    session_id: str | None = None,
    parent_run_id: str | None = None,
    caller: str | None = None,
    caller_kind: str | None = None,
    idempotency_key: str | None = None,
) -> Rendered:
    """Submit a task to an agent; returns the queued run."""
    check_submit(repo, alias, {"--base": base, "--no-base": no_base})
    if deadline is not None and deadline_in is not None:
        raise usage("give --deadline or --deadline-in, not both")
    if deadline_in is not None and deadline_in < 1:
        raise usage("--deadline-in must be a number of seconds of 1 or more")
    client = CoreClient()
    key, generated = _key(idempotency_key)
    common = {
        "agent_id": agent,
        "harness": harness,
        "task": task,
        "caller": _principal(client, caller, caller_kind),
        "idempotency_key": key,
    }
    if alias is not None:
        if deadline is not None or session_id or parent_run_id:
            raise usage(
                "a run on another member takes --deadline-in (a duration on that member's clock), "
                "and no --deadline, --session-id or --parent-run-id"
            )
        remote = {
            "alias": alias,
            "deadline_ms": deadline_in * 1000 if deadline_in is not None else None,
            "base_commit": remote_base(base, no_base),
        }
        return _submit_remote(client, {**common, **remote}, key, generated)
    if deadline_in is not None:  # this core's host is this host: one clock
        at = datetime.now(timezone.utc) + timedelta(seconds=deadline_in)
        deadline = at.strftime("%Y-%m-%dT%H:%M:%SZ")
    local = {
        "repo": os.path.abspath(repo) if repo else repo,
        "deadline": deadline,
        "session_id": session_id,
        "parent_run_id": parent_run_id,
    }
    sent = client.post_keyed("/v1/runs", "submit_response", _drop_none({**common, **local}))
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
    """Show one run (on another member: its view without the path)."""
    client = CoreClient()
    return _render.run_detail(client.get(*client.run_route(run_id)))


def runs_logs(run_id: str, after: int | None = None, limit: int | None = None) -> Rendered:
    """Read a page of a run's stored events."""
    query = {"after": after, "limit": limit}
    client = CoreClient()
    route = client.run_route(run_id)[0] + "/events"
    return _render.event_page(client.get(route, "event_page", query))


def runs_result(run_id: str, into: str | None = None, no_fetch: bool = False) -> Rendered:
    """Show the outcome of a finished run; on another member, also fetch its branch here."""
    client = CoreClient()
    route, shape = client.run_route(run_id)
    if shape == "run" and into is not None:
        raise CliError(
            code=EXIT_USER_ERROR,
            message="--into goes with a run on another member; this run's branch is on this host",
            remediation="see 'agents explain runs result'",
        )
    result = client.get(route + "/result", "run_result")
    done = _render.run_result(result)
    if shape == "run" or no_fetch or result["branch"] is None:
        return done
    return _fetch.with_branch(done, client, route, result["branch"], into)


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
    route = client.run_route(run_id)[0] + "/steer"
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
    route = client.run_route(run_id)[0] + "/cancel"
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
