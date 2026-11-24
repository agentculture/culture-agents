"""Minimal response-shape checks for what the core sends back.

The contract's JSON Schemas are the source of truth, but the runtime package
has zero third-party dependencies (no ``jsonschema``) and ``contract/`` is not
shipped in the wheel. So the CLI checks only the *shape* it relies on: required
keys and their JSON types. This is deliberately shallower than the schemas
(no patterns, enums or ``additionalProperties``); ``tests/test_cli_shapes.py``
pins it against every valid contract fixture so the two cannot drift
unnoticed. A payload that fails here is reported as ``internal`` (exit 2); the
CLI never passes an invalid payload on.

Spec language: a type or tuple of types; a ``dict`` (object with required
keys); a one-item ``list`` (array whose items match the item spec).
"""

from __future__ import annotations

from typing import Any

_NULL = type(None)
_STR_OR_NULL = (str, _NULL)

_PRINCIPAL = {"kind": str, "id": str}

CAPABILITIES = {"harness": str, "available": bool, "capabilities": dict}

AGENT = {
    "id": str,
    "node": str,
    "suffix": str,
    "harnesses": [str],
    "repos": [str],
    "state": str,
    "active_run_ids": [str],
}

RUN = {
    "id": str,
    "agent_id": str,
    "session_id": str,
    "harness": str,
    "repo": str,
    "task": str,
    "owner": _PRINCIPAL,
    "state": str,
    "state_reason": _STR_OR_NULL,
    "terminal": bool,
    "created_at": str,
    "updated_at": str,
    "started_at": _STR_OR_NULL,
    "ended_at": _STR_OR_NULL,
    "cursor": int,
    "live_control": bool,
    "branch": _STR_OR_NULL,
}

EVENT = {"run_id": str, "cursor": int, "time": str, "kind": str, "data": dict}

ERROR_BODY = {"error": {"code": str, "message": str, "retryable": (bool, _NULL)}}

SHAPES: dict[str, Any] = {
    "version": {"api_version": str, "core_version": str, "node": str},
    "agent": AGENT,
    "agent_list": {"node": str, "agents": [AGENT], "harnesses": [CAPABILITIES]},
    "capabilities": CAPABILITIES,
    "run": RUN,
    "run_list": {"runs": [RUN]},
    "run_result": {
        "run_id": str,
        "state": str,
        "summary": _STR_OR_NULL,
        "branch": _STR_OR_NULL,
        "commits": [str],
        "ended_at": _STR_OR_NULL,
    },
    "submit_response": {"run": RUN},
    "accepted_response": {
        "action": {"id": str, "run_id": str, "kind": str, "outcome": str, "caller": _PRINCIPAL}
    },
    "event": EVENT,
    "event_page": {"run_id": str, "events": [EVENT], "last_cursor": int, "more": bool},
    "error": ERROR_BODY,
}


def problem(value: Any, spec: Any, path: str = "$") -> str | None:
    """Why *value* does not match *spec*, or ``None`` when it does."""
    if isinstance(spec, dict):
        if not isinstance(value, dict):
            return f"{path}: expected an object"
        for key, sub in spec.items():
            if key not in value:
                return f"{path}.{key}: missing required key"
            found = problem(value[key], sub, f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(spec, list):
        if not isinstance(value, list):
            return f"{path}: expected an array"
        for index, item in enumerate(value):
            found = problem(item, spec[0], f"{path}[{index}]")
            if found:
                return found
        return None
    types = spec if isinstance(spec, tuple) else (spec,)
    # bool is an int subclass; never accept True for an integer field.
    if isinstance(value, bool) and bool not in types:
        return f"{path}: unexpected boolean"
    if not isinstance(value, types):
        names = "/".join(t.__name__ for t in types)
        return f"{path}: expected {names}, got {type(value).__name__}"
    return None


def check(name: str, value: Any) -> str | None:
    """Shape problem for the named payload kind, or ``None``."""
    return problem(value, SHAPES[name])
