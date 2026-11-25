"""Shared loaders and checkers for the control-plane contract tests.

Test-only helpers. They build their own validators from ``contract/`` on disk,
independently of ``culture_agents.cli._contract`` (the CLI's runtime
validation), so the tests can check one against the other. Nothing here touches
the network, a socket or a chat server.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT = REPO_ROOT / "contract"
FIXTURES = CONTRACT / "fixtures"
API_INDEX = CONTRACT / "api.json"
ID_BASE = "https://culture.dev/contract/agents/"
DRAFT = "https://json-schema.org/draft/2020-12/schema"

#: The one opaque field allowed to hold harness-specific data.
EXTENSION_DEF = ("common.json", "extension")

#: Names that must never appear in a schema or in api.json (case-insensitive
#: substring match). AI-SDK, OpenShell and vendor-SDK type and package names.
DENY_LIST = (
    "HarnessV1",
    "HarnessAgent",
    "HarnessSession",
    "SandboxSession",
    "ai-sdk",
    "aisdk",
    "@ai-sdk",
    "vercel",
    "openshell",
    "claude-agent-sdk",
    "ClaudeAgent",
    "ClaudeSDK",
    "codex-sdk",
    "CodexThread",
    "app-server",
    "anthropic",
    "openai",
    "UIMessage",
    "LanguageModel",
    "StreamTextResult",
    "submitUserMessage",
    "doSuspendTurn",
    "doContinueTurn",
    "opencode-ai",
)

#: Keys whose objects are constraints layered on an already-closed object.
_LAYERED = ("if", "then", "else", "not")


def schema_files() -> list[Path]:
    """Every JSON Schema file (api.json is an index, not a schema)."""
    return sorted(p for p in CONTRACT.glob("*.json") if p.name != "api.json")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_schemas() -> dict[str, dict]:
    """File name -> parsed schema."""
    return {p.name: load_json(p) for p in schema_files()}


def registry() -> Registry:
    resources = [
        (schema["$id"], Resource.from_contents(schema)) for schema in load_schemas().values()
    ]
    return Registry().with_resources(resources)


def validator_for(target: str, reg: Registry | None = None) -> Draft202012Validator:
    """A validator for ``file.json`` or ``file.json#/$defs/name``."""
    reg = reg or registry()
    return Draft202012Validator({"$ref": ID_BASE + target}, registry=reg)


def resolve_target(target: str, reg: Registry | None = None) -> Any:
    reg = reg or registry()
    return reg.resolver().lookup(ID_BASE + target).contents


def fixture_target(path: Path) -> str:
    """Map ``fixtures/<kind>/<stem>/<target>.<label>.json`` to a schema ref."""
    stem = path.parent.name
    target = path.name.split(".", 1)[0]
    if target == "root":
        return f"{stem}.json"
    return f"{stem}.json#/$defs/{target}"


def fixture_keyword(path: Path) -> str:
    """The JSON Schema keyword an invalid fixture is named to fail on."""
    label = path.name.split(".", 1)[1].removesuffix(".json")
    return label.split("-", 1)[0]


def fixtures(kind: str) -> list[Path]:
    return sorted((FIXTURES / kind).glob("*/*.json"))


def walk_errors(errors: Iterator[ValidationError]) -> Iterator[ValidationError]:
    """Every error, including those nested under oneOf/anyOf context."""
    for err in errors:
        yield err
        yield from walk_errors(iter(err.context or ()))


def iter_subschemas(node: Any, path: tuple = ()) -> Iterator[tuple[tuple, Any]]:
    """Yield (path, node) for every dict in a schema document."""
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from iter_subschemas(value, path + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from iter_subschemas(value, path + (index,))


def open_objects(name: str, schema: dict) -> list[tuple]:
    """Object schemas that do not set ``additionalProperties: false``."""
    found = []
    for path, node in iter_subschemas(schema):
        if any(key in _LAYERED for key in path if isinstance(key, str)):
            continue
        if path and path[-1] in ("properties", "$defs"):
            continue
        if "$ref" in node:
            continue  # narrows a referenced schema, which is itself checked
        is_object = node.get("type") == "object" or "properties" in node
        if not is_object or node.get("additionalProperties") is False:
            continue
        if (name, path[-1] if path else None) == EXTENSION_DEF and path[:-1] == ("$defs",):
            continue
        found.append(path)
    return found


def refs_in(node: Any) -> Iterator[str]:
    for _, sub in iter_subschemas(node):
        ref = sub.get("$ref")
        if isinstance(ref, str):
            yield ref


def denied_names(text: str) -> list[str]:
    lowered = text.lower()
    return [name for name in DENY_LIST if name.lower() in lowered]


def api_index() -> dict:
    return load_json(API_INDEX)


# --- event stream checking ------------------------------------------------


def stream_problems(lines: list[dict], api: dict, reg: Registry) -> list[str]:
    """Why an event stream breaks the contract's stream rules (empty = valid)."""
    problems: list[str] = []
    machine = api["state_machine"]
    terminal = set(machine["terminal"])
    validator = validator_for("event.json", reg)
    run_ids = {event.get("run_id") for event in lines}
    if len(run_ids) != 1:
        problems.append(f"stream mixes run ids: {sorted(map(str, run_ids))}")
    state = None
    for index, event in enumerate(lines, start=1):
        errors = list(validator.iter_errors(event))
        if errors:
            problems.append(f"event {index} invalid: {errors[0].message}")
            continue
        if event["cursor"] != index:
            problems.append(f"event {index} has cursor {event['cursor']}, expected {index}")
        if state in terminal:
            problems.append(f"event {index} follows terminal state {state}")
        if event["kind"] == "run.state":
            data = event["data"]
            if data["from"] != state:
                problems.append(f"event {index} from={data['from']} but state is {state}")
            allowed = machine["initial"] if state is None else machine["transitions"][state]
            allowed = [allowed] if isinstance(allowed, str) else allowed
            if data["to"] not in allowed:
                problems.append(f"event {index}: illegal transition {state} -> {data['to']}")
            state = data["to"]
        elif index == 1:
            problems.append("first event must be run.state to the initial state")
    return problems


def read_stream(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
