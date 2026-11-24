"""Control-plane contract: schema well-formedness and the fixture kit.

The TS core reuses the same fixtures in its own suite; these tests are the
Python half of "both sides validate against the same files".
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from tests import contract_support as cs

SCHEMAS = cs.load_schemas()
REG = cs.registry()
VALID = cs.fixtures("valid")
INVALID = cs.fixtures("invalid")

#: The entity files the plan requires, plus the shared and auxiliary ones.
REQUIRED_SCHEMAS = {
    "agent.json",
    "session.json",
    "run.json",
    "control-action.json",
    "event.json",
    "capabilities.json",
    "error.json",
    "common.json",
    "version.json",
    "allowlist.json",
}


def _rel(path: Path) -> str:
    return str(path.relative_to(cs.FIXTURES))


# --- schema files -----------------------------------------------------------


def test_every_required_schema_exists():
    assert REQUIRED_SCHEMAS <= set(SCHEMAS), REQUIRED_SCHEMAS - set(SCHEMAS)


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_schema_is_valid_draft_2020_12(name):
    schema = SCHEMAS[name]
    assert schema.get("$schema") == cs.DRAFT
    assert schema.get("$id") == cs.ID_BASE + name
    Draft202012Validator.check_schema(schema)


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_every_object_is_closed_except_the_extension(name):
    assert cs.open_objects(name, SCHEMAS[name]) == []


def test_extension_is_the_only_open_object_and_is_opaque():
    ext = SCHEMAS["common.json"]["$defs"]["extension"]
    assert ext["type"] == "object"
    assert "additionalProperties" not in ext and "properties" not in ext


def test_extension_is_only_referenced_by_a_property_named_extension():
    for name, schema in SCHEMAS.items():
        for path, node in cs.iter_subschemas(schema):
            if str(node.get("$ref", "")).endswith("common.json#/$defs/extension"):
                assert path[-2:-1] == ("properties",) and path[-1] == "extension", (name, path)


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_every_ref_resolves(name):
    resolver = REG.resolver(base_uri=SCHEMAS[name]["$id"])
    for ref in cs.refs_in(SCHEMAS[name]):
        resolver.lookup(ref)  # raises Unresolvable on a dangling $ref


# --- vendor-neutrality --------------------------------------------------------


@pytest.mark.parametrize("path", cs.schema_files() + [cs.API_INDEX], ids=lambda p: p.name)
def test_no_ai_sdk_openshell_or_vendor_sdk_name(path):
    assert cs.denied_names(path.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize("planted", ["HarnessAgent", "harnessv1", "@ai-sdk/harness", "OpenShell"])
def test_deny_list_catches_a_planted_name(planted):
    text = '{"description": "wraps a %s"}' % planted
    assert cs.denied_names(text)


def test_harness_ids_are_free_strings_not_an_enum():
    harness = SCHEMAS["common.json"]["$defs"]["harness_id"]
    assert harness["type"] == "string" and "enum" not in harness


# --- fixtures -----------------------------------------------------------------


def test_fixture_kit_is_not_empty():
    assert len(VALID) >= 20 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=_rel)
def test_valid_fixture_validates(path):
    validator = cs.validator_for(cs.fixture_target(path), REG)
    errors = [e.message for e in validator.iter_errors(cs.load_json(path))]
    assert errors == []


@pytest.mark.parametrize("path", INVALID, ids=_rel)
def test_invalid_fixture_is_rejected_for_its_stated_reason(path):
    validator = cs.validator_for(cs.fixture_target(path), REG)
    errors = list(cs.walk_errors(validator.iter_errors(cs.load_json(path))))
    assert errors, "expected a rejection"
    keyword = cs.fixture_keyword(path)
    assert keyword in {e.validator for e in errors}, [(e.validator, e.message) for e in errors]


@pytest.mark.parametrize("path", INVALID, ids=_rel)
def test_invalid_fixture_fails_for_one_reason_only(path):
    """Top-level errors share one keyword; ``anyOf`` echoes of it are allowed."""
    validator = cs.validator_for(cs.fixture_target(path), REG)
    keywords = {e.validator for e in validator.iter_errors(cs.load_json(path))} - {"anyOf"}
    assert keywords == {cs.fixture_keyword(path)}


@pytest.mark.parametrize("path", VALID + INVALID, ids=_rel)
def test_fixture_targets_an_existing_schema(path):
    cs.resolve_target(cs.fixture_target(path), REG)


@pytest.mark.parametrize("name", sorted(REQUIRED_SCHEMAS - {"common.json"}))
def test_every_schema_file_has_valid_and_invalid_fixtures(name):
    stem = name.removesuffix(".json")
    assert list((cs.FIXTURES / "valid" / stem).glob("*.json")), f"no valid fixture for {name}"
    assert list((cs.FIXTURES / "invalid" / stem).glob("*.json")), f"no invalid fixture for {name}"


def test_validation_needs_no_chat_server_network_or_home(tmp_path, monkeypatch):
    """Validation is pure: no culture/chat config, no HOME, no socket."""
    monkeypatch.setenv("HOME", str(tmp_path))
    for var in [v for v in os.environ if v.startswith(("CULTURE", "AGENTIRC"))]:
        monkeypatch.delenv(var)

    def refuse(*_args, **_kwargs):
        raise AssertionError("contract validation tried to open a socket")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    reg = cs.registry()
    for path in VALID:
        cs.validator_for(cs.fixture_target(path), reg).validate(cs.load_json(path))
