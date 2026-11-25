"""The stdlib socket client: transport rules, version rule, error table."""

from __future__ import annotations


import pytest

from culture_agents.cli import _client, _stream
from culture_agents.cli._client import (
    CLIENT_API_VERSION,
    EXIT_FOR_CODE,
    CoreClient,
    error_from_body,
    socket_path,
    versions_compatible,
)
from culture_agents.cli._errors import CoreError
from tests import contract_support as cs
from tests.fake_core import fixture

API = cs.api_index()


def test_client_version_matches_the_contract() -> None:
    assert CLIENT_API_VERSION == API["api_version"]
    assert API["transport"]["version_header"] == _client.VERSION_HEADER
    assert API["transport"]["socket_override_env"] == _client.SOCKET_ENV


def test_socket_path_precedence() -> None:
    assert socket_path({"CULTURE_AGENTS_SOCKET": "/x/y.sock", "XDG_RUNTIME_DIR": "/run/u"}) == (
        "/x/y.sock"
    )
    assert socket_path({"XDG_RUNTIME_DIR": "/run/u"}) == "/run/u/culture-agents/core.sock"
    home = {"HOME": "/home/u"}
    assert socket_path(home) == "/home/u/.local/state/culture-agents/core.sock"
    assert socket_path({"XDG_RUNTIME_DIR": "", **home}) == (
        "/home/u/.local/state/culture-agents/core.sock"
    )
    assert socket_path({"XDG_STATE_HOME": "/s", **home}) == "/s/culture-agents/core.sock"
    assert socket_path({"XDG_STATE_HOME": "relative", **home}) == (
        "/home/u/.local/state/culture-agents/core.sock"
    )
    assert "/tmp" not in socket_path(home)


@pytest.mark.parametrize(
    ("client", "server", "ok"),
    [
        ("1.0", "1.0", True),
        ("1.0", "1.3", True),
        ("1.2", "1.1", False),  # the core's MINOR must be >= the client's
        ("1.0", "2.0", False),
        ("2.0", "1.9", False),
        ("1.10", "1.9", False),  # numeric, not lexical
    ],
)
def test_compatibility_rule(client: str, server: str, ok: bool) -> None:
    assert versions_compatible(client, server) is ok


def test_exit_codes_match_the_contract_error_table() -> None:
    assert {c: spec["exit_code"] for c, spec in API["errors"].items()} == EXIT_FOR_CODE


@pytest.mark.parametrize("path", sorted((cs.FIXTURES / "valid" / "error").glob("*.json")))
def test_every_error_fixture_maps_to_its_exit_code(path) -> None:
    body = cs.load_json(path)
    err = error_from_body(400, body)
    code = body["error"]["code"]
    assert err.code == EXIT_FOR_CODE[code]
    assert err.error_code == code
    assert err.message.startswith(f"{code}: ")
    assert err.remediation


def test_an_unrecognised_error_body_is_internal() -> None:
    for body in (None, "x", {"error": {"code": "weird", "message": "m", "retryable": False}}):
        err = error_from_body(500, body)
        assert (err.code, err.error_code) == (2, "internal")


# --- over the socket ---------------------------------------------------------


def test_every_request_carries_the_version_header(core) -> None:
    client = CoreClient()
    client.get("/v1/runs", "run_list")
    assert {r["version_header"] for r in core.requests} == {"1.0"}
    assert core.requests[0]["path"] == "/v1/version"  # version first, once
    client.get("/v1/runs", "run_list")
    assert [r["path"] for r in core.requests].count("/v1/version") == 1


def test_node_comes_from_the_version_route(core) -> None:
    assert CoreClient().node == "spark"


def test_unreachable_socket_raises_unavailable(no_core) -> None:
    with pytest.raises(CoreError) as exc:
        CoreClient().connect()
    assert (exc.value.code, exc.value.error_code) == (2, "unavailable")


def test_attach_gives_up_after_repeated_empty_reconnects(core, monkeypatch) -> None:
    monkeypatch.setattr(_stream.time, "sleep", lambda _s: None)
    core.attach_cutoffs = [0] * 20  # every connection closes without an event
    events = CoreClient().attach(fixture("run", "root.running")["id"])  # lazy: nothing runs yet
    with pytest.raises(CoreError) as exc:
        list(events)
    assert exc.value.error_code == "unavailable"
