"""The flags of the ``agents runs`` verbs (kept apart from the handlers in ``runs.py``)."""

from __future__ import annotations

from agentfront import Flag

from culture_agents.cli._remote import OneDeadline

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
        names=("--deadline",),
        dest="deadline",
        action=OneDeadline,  # an argparse Action class: agentfront hands it to argparse
        help="absolute UTC time, e.g. 2026-11-25T11:00:00Z (or --deadline-in, not both)",
    ),
    Flag(
        names=("--deadline-in",),
        dest="deadline",  # one deadline: an int here is seconds, a str from --deadline a time
        type=int,
        action=OneDeadline,
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
    Flag(
        names=("--limit",),
        dest="limit",
        type=int,
        help="at most this many (1-5000; 1-50 for a run on another member)",
    ),
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
