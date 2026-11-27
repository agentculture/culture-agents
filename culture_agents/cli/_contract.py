"""Validate what the core sends against the contract's JSON Schemas.

``contract/README.md``: a response that does not validate is an ``internal``
error (exit 2), and the CLI must not pass on an invalid payload. The schemas
are the ones in the repository's ``contract/`` directory. The wheel carries
them as ``culture_agents/contract/*.json`` (``pyproject.toml`` force-includes
the files at build time, so no second copy is kept in the tree); a source
checkout reads ``contract/`` directly.

``$ref``s between the files resolve through a registry of those local files.
Nothing is ever fetched: a reference outside the registry is an error. The
registry and each validator are built once per process, on first use, so a
verb that never talks to the core does not pay for importing ``jsonschema``.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from culture_agents.cli._errors import EXIT_ENV_ERROR, CliError
from culture_agents.cli._text import visible

ID_BASE = "https://culture.dev/contract/agents/"

#: Payload name -> the schema it must validate against (file, or file#/$defs/name).
TARGETS: dict[str, str] = {
    "version": "version.json",
    "agent": "agent.json",
    "agent_list": "agent.json#/$defs/agent_list",
    "capabilities": "capabilities.json",
    "run": "run.json",
    "run_list": "run.json#/$defs/run_list",
    "run_result": "run.json#/$defs/run_result",
    "submit_response": "control-action.json#/$defs/submit_response",
    "accepted_response": "control-action.json#/$defs/accepted_response",
    "event": "event.json",
    "event_page": "event.json#/$defs/event_page",
    "error": "error.json",
    "branch_list": "branches.json",
    "branch_remove_request": "branches.json#/$defs/remove_request",
    "branch_remove": "branches.json#/$defs/remove_response",
    "member_list": "fleet.json",
    "unreadable_list": "unreadable.json",
}

_PACKAGE = Path(__file__).resolve().parent.parent
#: Installed wheel first, then the root of a source checkout.
_CANDIDATES = (_PACKAGE / "contract", _PACKAGE.parent / "contract")
_MAX_PROBLEM = 300


def schema_dir() -> Path:
    """The directory holding the contract schemas for this install."""
    for candidate in _CANDIDATES:
        if (candidate / "common.json").is_file():
            return candidate
    raise CliError(
        code=EXIT_ENV_ERROR,
        message="the contract schemas are missing from this culture-agents install",
        remediation="reinstall culture-agents; the wheel ships them as culture_agents/contract/",
    )


def load_schemas(directory: Path | None = None) -> dict[str, dict[str, Any]]:
    """``$id`` -> schema, for every schema file (``api.json`` is an index, not a schema)."""
    found: dict[str, dict[str, Any]] = {}
    for path in sorted((directory or schema_dir()).glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(document, dict) and isinstance(document.get("$id"), str):
            found[document["$id"]] = document
    return found


@lru_cache(maxsize=1)
def _registry() -> Any:
    from referencing import Registry, Resource

    resources = [(uri, Resource.from_contents(schema)) for uri, schema in load_schemas().items()]
    return Registry().with_resources(resources)  # no retrieve hook: nothing is fetched


@lru_cache(maxsize=None)
def validator(name: str) -> Any:
    """The compiled validator for payload *name* (see :data:`TARGETS`)."""
    from jsonschema import Draft202012Validator

    return Draft202012Validator({"$ref": ID_BASE + TARGETS[name]}, registry=_registry())


def problem(name: str, value: Any) -> str | None:
    """Why *value* is not a valid *name* payload, or ``None`` when it is."""
    from jsonschema.exceptions import best_match

    error = best_match(validator(name).iter_errors(value))
    if error is None:
        return None
    text = visible(f"{error.json_path}: {error.message}")
    return text if len(text) <= _MAX_PROBLEM else text[: _MAX_PROBLEM - 3] + "..."
