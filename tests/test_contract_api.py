"""Control-plane contract: the api.json index, identifiers and event streams."""

from __future__ import annotations

import re

import pytest

from tests import contract_support as cs

API = cs.api_index()
SCHEMAS = cs.load_schemas()
REG = cs.registry()
COMMON = SCHEMAS["common.json"]["$defs"]
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "unanswered", "unknown"}
D1_ROUTES = {
    "version",
    "agents.list",
    "agents.status",
    "harnesses.list",
    "harnesses.show",
    "runs.submit",
    "runs.list",
    "runs.show",
    "runs.attach",
    "runs.steer",
    "runs.cancel",
    "runs.logs",
    "runs.result",
    "branches.list",
    "branches.remove",
}
DEFERRED_ROUTES = {"runs.pause", "runs.resume", "runs.answer"}
#: Pinned to unsupported by the schema in 3.0.
DEFERRED_CAPABILITIES = {
    "pause",
    "resume",
    "delegate",
    "placement",
    "continue_session",
}
#: Deferred in 2.0; in 3.0 a harness may report them supported (README: changes from 2.0).
SUPPORTABLE_SINCE_3_0 = {"answer", "reconnect", "worktree_isolation"}
ENVIRONMENT_ERRORS = {"incompatible_version", "unavailable", "internal"}


def _route(route_id: str) -> dict:
    return next(r for r in API["routes"] if r["id"] == route_id)


# --- api.json -----------------------------------------------------------------


def test_api_version_format_and_base():
    assert re.fullmatch(r"[0-9]+\.[0-9]+", API["api_version"])
    assert API["schema_base"] == cs.ID_BASE


def test_version_fixtures_carry_the_index_api_version():
    paths = list((cs.FIXTURES / "valid" / "version").glob("root.*.json"))
    assert paths
    for path in paths:
        assert cs.load_json(path)["api_version"] == API["api_version"], path.name


def test_routes_are_unique():
    ids = [r["id"] for r in API["routes"]]
    keys = [(r["method"], r["path"]) for r in API["routes"]]
    assert len(ids) == len(set(ids))
    assert len(keys) == len(set(keys))


def test_d1_and_deferred_routes_present():
    by_id = {r["id"]: r for r in API["routes"]}
    assert D1_ROUTES | DEFERRED_ROUTES == set(by_id)
    assert all(by_id[i]["d1"] == "supported" for i in D1_ROUTES)
    assert all(by_id[i]["d1"] == "unsupported" for i in DEFERRED_ROUTES)


@pytest.mark.parametrize("route", API["routes"], ids=lambda r: r["id"])
def test_route_references_only_existing_schemas(route):
    assert route["method"] in ("GET", "POST")
    if route["method"] == "GET":
        assert route["request"] is None
    for ref in (route["request"], route["response"], *route.get("params", {}).values()):
        if ref is not None:
            assert (cs.CONTRACT / ref.split("#", 1)[0]).is_file(), ref
            cs.resolve_target(ref, REG)


@pytest.mark.parametrize("route", API["routes"], ids=lambda r: r["id"])
def test_route_query_refs_resolve(route):
    for name, spec in route["query"].items():
        if "$ref" in spec:
            cs.resolve_target(spec["$ref"], REG)
        else:
            assert spec["type"] == "integer", name


@pytest.mark.parametrize("route", API["routes"], ids=lambda r: r["id"])
def test_route_payloads_have_valid_fixtures(route):
    targets = {cs.fixture_target(p) for p in cs.fixtures("valid")}
    for ref in (route["request"], route["response"]):
        if ref is not None:
            assert ref in targets, f"no valid fixture for {ref}"


@pytest.mark.parametrize("route", API["routes"], ids=lambda r: r["id"])
def test_route_path_params_are_declared(route):
    in_path = set(re.findall(r"{([a-z_]+)}", route["path"]))
    assert in_path == set(route.get("params", {}))


@pytest.mark.parametrize("route", API["routes"], ids=lambda r: r["id"])
def test_route_errors_and_streaming_are_consistent(route):
    assert set(route["errors"]) <= set(API["errors"]), route["errors"]
    if route["stream"]:
        assert route["response"] == "event.json"
        assert route["content_type"] == "text/event-stream"
    else:
        assert route["content_type"] == "application/json"
        assert route["response"] != "event.json"
    if route["d1"] == "unsupported":
        assert "unsupported" in route["errors"]


def test_error_table_matches_error_schema_and_exit_codes():
    codes = set(SCHEMAS["error.json"]["$defs"]["code"]["enum"])
    assert codes == set(API["errors"])
    assert {"unsupported", "limit_reached", "denied", "not_found", "invalid"} <= codes
    assert "busy" not in codes  # removed in 3.0 by t8
    assert {"incompatible_version", "unavailable"} <= codes
    for code, row in API["errors"].items():
        assert row["exit_code"] == (2 if code in ENVIRONMENT_ERRORS else 1), code
        assert 400 <= row["http_status"] <= 599


def test_state_machine_matches_run_schema():
    machine = API["state_machine"]
    states = set(SCHEMAS["run.json"]["$defs"]["state"]["enum"])
    assert set(machine["terminal"]) == TERMINAL
    assert set(machine["transitions"]) == states
    assert set(machine["active"]) | TERMINAL == states
    assert set(SCHEMAS["run.json"]["$defs"]["terminal_state"]["enum"]) == TERMINAL
    for state, targets in machine["transitions"].items():
        assert set(targets) <= states
        assert (targets == []) == (state in TERMINAL), state


def test_deferred_capabilities_are_declared_unsupported():
    caps = SCHEMAS["capabilities.json"]["$defs"]["capability_set"]
    assert set(caps["required"]) == set(caps["properties"])
    core = {"submit", "stream", "steer", "cancel"}
    assert DEFERRED_CAPABILITIES | SUPPORTABLE_SINCE_3_0 | core == set(caps["required"])
    for name in DEFERRED_CAPABILITIES:
        assert caps["properties"][name]["$ref"].endswith("#/$defs/deferred"), name
    for name in SUPPORTABLE_SINCE_3_0 | core:
        assert caps["properties"][name]["$ref"].endswith("#/$defs/capability"), name
    deferred = SCHEMAS["capabilities.json"]["$defs"]["deferred"]
    assert deferred["properties"]["supported"] == {"const": False}


def test_capability_names_used_by_errors_are_known():
    names = set(SCHEMAS["capabilities.json"]["$defs"]["capability_name"]["enum"])
    assert names == set(SCHEMAS["capabilities.json"]["$defs"]["capability_set"]["required"])


# --- identifiers ----------------------------------------------------------------


@pytest.mark.parametrize("good", ["thor-culture-agents", "thor-claude", "n1-reachy_nova"])
def test_mesh_id_accepts_node_agent_form(good):
    assert re.fullmatch(COMMON["mesh_id"]["pattern"], good)


@pytest.mark.parametrize("bad", ["thor", "Thor-x", "thor-", "-x", "thor--x", "th.or-x"])
def test_mesh_id_rejects_other_forms(bad):
    assert not re.fullmatch(COMMON["mesh_id"]["pattern"], bad)


def test_run_session_and_action_ids_embed_the_agent_id():
    ulid = "01JDQ5V7M2K8X9Y0Z1A2B3C4D5"
    for kind, tag in (("run_id", "run"), ("session_id", "ses"), ("action_id", "act")):
        pattern = COMMON[kind]["pattern"]
        assert re.fullmatch(pattern, f"thor-culture-agents.{tag}.{ulid}"), kind
        assert not re.fullmatch(pattern, f"culture.{tag}.{ulid}"), kind
        assert not re.fullmatch(pattern, f"thor-culture-agents.{tag}.{ulid.lower()}"), kind


def test_inlined_patterns_do_not_drift_from_their_sources():
    assert COMMON["nullable_timestamp"]["pattern"] == COMMON["timestamp"]["pattern"]
    branch = SCHEMAS["run.json"]["properties"]["branch"]["pattern"]
    assert branch == "^runs/" + COMMON["run_id"]["pattern"].removeprefix("^")


ID_PROPS = {
    "agent_id": "mesh_id",
    "run_id": "run_id",
    "session_id": "session_id",
    "parent_run_id": "run_id",
}


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_identifier_properties_use_the_common_definitions(name):
    for path, node in cs.iter_subschemas(SCHEMAS[name]):
        if len(path) < 2 or path[-2] != "properties" or path[-1] not in ID_PROPS:
            continue
        text = str(node)
        assert f"common.json#/$defs/{ID_PROPS[path[-1]]}" in text or (
            name == "common.json" and f"#/$defs/{ID_PROPS[path[-1]]}" in text
        ), (name, path)


def _objects(node):
    for _, sub in cs.iter_subschemas(node):
        yield sub


@pytest.mark.parametrize("path", cs.fixtures("valid"), ids=lambda p: p.name)
def test_valid_fixture_ids_agree_with_their_agent(path):
    for obj in _objects(cs.load_json(path)):
        agent = obj.get("agent_id")
        if "node" in obj and "suffix" in obj and "id" in obj:
            assert obj["id"] == f"{obj['node']}-{obj['suffix']}"
        if not isinstance(agent, str):
            continue
        for key in ("id", "run_id", "session_id"):
            value = obj.get(key)
            if isinstance(value, str) and re.search(r"\.(run|ses)\.", value):
                assert value.startswith(agent + "."), (key, value, agent)


# --- event streams --------------------------------------------------------------

STREAMS_VALID = sorted((cs.FIXTURES / "streams" / "valid").glob("*.jsonl"))
STREAMS_INVALID = sorted((cs.FIXTURES / "streams" / "invalid").glob("*.jsonl"))


def test_stream_fixtures_exist():
    assert len(STREAMS_VALID) >= 3
    assert len(STREAMS_INVALID) >= 3


@pytest.mark.parametrize("path", STREAMS_VALID, ids=lambda p: p.name)
def test_valid_stream_obeys_cursor_and_state_rules(path):
    assert cs.stream_problems(cs.read_stream(path), API, REG) == []


@pytest.mark.parametrize("path", STREAMS_INVALID, ids=lambda p: p.name)
def test_invalid_stream_is_caught(path):
    assert cs.stream_problems(cs.read_stream(path), API, REG)


@pytest.mark.parametrize("path", STREAMS_VALID, ids=lambda p: p.name)
def test_valid_stream_ends_in_a_terminal_state(path):
    events = cs.read_stream(path)
    last = events[-1]
    assert last["kind"] == "run.state"
    assert last["data"]["to"] in TERMINAL
