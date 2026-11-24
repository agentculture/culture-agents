"""Client for the core's control API: HTTP/1.1 over a Unix socket, stdlib only.

Implements the transport, version and error rules of ``contract/README.md``:

* socket path from ``CULTURE_AGENTS_SOCKET``, else
  ``$XDG_RUNTIME_DIR/culture-agents/core.sock``, else
  ``/tmp/culture-agents-<uid>/core.sock``;
* ``GET /v1/version`` on connect, refusing an incompatible core (exit 2);
* ``Agents-Api-Version`` on every request;
* typed error bodies mapped to CLI exit codes (0 ok, 1 user, 2 environment);
* a missing or refused socket reported as ``unavailable`` (exit 2);
* a response that does not match its shape reported as ``internal`` (exit 2);
* the ``attach`` server-sent-event stream, parsed by hand, with a cursor so a
  broken stream resumes without a gap or a duplicate.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote, urlencode

from culture_agents.cli import _shapes
from culture_agents.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CoreError

#: The contract's ``api.json`` -> ``api_version``. ``tests/test_cli_client.py``
#: fails if this drifts from the contract.
CLIENT_API_VERSION = "1.0"
VERSION_HEADER = "Agents-Api-Version"
SOCKET_ENV = "CULTURE_AGENTS_SOCKET"

#: Typed error code -> CLI exit code (contract README, "Errors and CLI exit codes").
EXIT_FOR_CODE = {
    "invalid": EXIT_USER_ERROR,
    "denied": EXIT_USER_ERROR,
    "not_found": EXIT_USER_ERROR,
    "busy": EXIT_USER_ERROR,
    "conflict": EXIT_USER_ERROR,
    "unsupported": EXIT_USER_ERROR,
    "incompatible_version": EXIT_ENV_ERROR,
    "unavailable": EXIT_ENV_ERROR,
    "internal": EXIT_ENV_ERROR,
}

_HINTS = {
    "invalid": "fix the request and retry; see 'agents explain runs' for the verbs and flags",
    "denied": (
        "dispatch is deny-by-default: the operator must add a matching agent, harness and repo "
        "entry to the allow-list file; the CLI cannot grant it"
    ),
    "not_found": "list what exists with 'agents agents list' or 'agents runs list'",
    "busy": "wait for the active run to end, or cancel it with 'agents runs cancel <run_id>'",
    "conflict": "inspect the run with 'agents runs show <run_id>', then retry when it allows",
    "unsupported": (
        "the core refuses this capability on purpose; see which ones a harness supports with "
        "'agents agents status <agent_id>'"
    ),
    "incompatible_version": "upgrade culture-agents or the core so the API major versions match",
    "unavailable": "check that the core, its worker and the harness are running, then retry",
    "internal": "report this at https://github.com/agentculture/culture-agents/issues",
}

_START_HINT = (
    "start the core daemon, or point CULTURE_AGENTS_SOCKET at its socket "
    "(see 'agents explain agents')"
)
_STREAM_TIMEOUT = 45.0  # the core sends a keepalive at least every 15 s
_MAX_STALLED_RECONNECTS = 5
_TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled", "timed_out", "unknown"})


def socket_path(env: dict[str, str] | None = None) -> str:
    """The control socket path, per the contract's transport section."""
    env = os.environ if env is None else env
    if env.get(SOCKET_ENV):
        return env[SOCKET_ENV]
    if env.get("XDG_RUNTIME_DIR"):
        return os.path.join(env["XDG_RUNTIME_DIR"], "culture-agents", "core.sock")
    return f"/tmp/culture-agents-{os.getuid()}/core.sock"  # nosec B108


def parse_api_version(text: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)", text)
    if not match:
        raise ValueError(text)
    return int(match.group(1)), int(match.group(2))


def versions_compatible(client: str, server: str) -> bool:
    """Same MAJOR, and the core's MINOR is at least the client's."""
    c_major, c_minor = parse_api_version(client)
    s_major, s_minor = parse_api_version(server)
    return c_major == s_major and s_minor >= c_minor


def _internal(message: str) -> CoreError:
    return CoreError(
        code=EXIT_ENV_ERROR,
        message=message,
        remediation=_HINTS["internal"],
        error_code="internal",
    )


def _unavailable(path: str, why: str) -> CoreError:
    return CoreError(
        code=EXIT_ENV_ERROR,
        message=f"cannot reach the core at {path}: {why}",
        remediation=_START_HINT,
        error_code="unavailable",
    )


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._unix_path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self._unix_path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def error_from_body(status: int, body: Any) -> CoreError:
    """Map a non-2xx response to the CLI error it stands for."""
    found = _shapes.check("error", body) if isinstance(body, dict) else "not an object"
    if found or body["error"]["code"] not in EXIT_FOR_CODE:
        return _internal(f"the core answered HTTP {status} with an unrecognised error body")
    err = body["error"]
    code = err["code"]
    extra = {k: v for k, v in err.items() if k not in ("code", "message")}
    return CoreError(
        code=EXIT_FOR_CODE[code],
        message=f"{code}: {err['message']}",
        remediation=_HINTS[code],
        error_code=code,
        detail=extra,
    )


class CoreClient:
    """One connection policy for every verb; connections themselves are per request."""

    def __init__(self, path: str | None = None, timeout: float = 10.0) -> None:
        self.path = path or socket_path()
        self.timeout = timeout
        self._version: dict[str, Any] | None = None

    # -- transport ---------------------------------------------------------
    def _open(
        self, method: str, route: str, body: Any = None, timeout: float | None = None
    ) -> tuple[_UnixConnection, http.client.HTTPResponse]:
        conn = _UnixConnection(self.path, timeout or self.timeout)
        headers = {VERSION_HEADER: CLIENT_API_VERSION, "Accept": "application/json"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, route, body=payload, headers=headers)
            return conn, conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise _unavailable(self.path, _describe(exc)) from exc

    def _json(self, method: str, route: str, shape: str, body: Any = None) -> Any:
        conn, resp = self._open(method, route, body)
        try:
            raw = resp.read()
            status = resp.status
        except (OSError, http.client.HTTPException) as exc:
            raise _unavailable(self.path, _describe(exc)) from exc
        finally:
            conn.close()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, ValueError):
            parsed = None
        if not 200 <= status < 300:
            raise error_from_body(status, parsed)
        found = _shapes.check(shape, parsed)
        if found:
            raise _internal(f"the core sent an invalid {shape} payload ({found})")
        return parsed

    # -- version -----------------------------------------------------------
    def connect(self) -> dict[str, Any]:
        """``GET /v1/version``; refuse an incompatible core. Cached per client."""
        if self._version is None:
            info = self._json("GET", "/v1/version", "version")
            try:
                ok = versions_compatible(CLIENT_API_VERSION, info["api_version"])
            except ValueError:
                raise _internal(f"the core reports a malformed api_version {info['api_version']!r}")
            if not ok:
                raise CoreError(
                    code=EXIT_ENV_ERROR,
                    message=(
                        f"incompatible API version: this client speaks {CLIENT_API_VERSION}, "
                        f"the core speaks {info['api_version']}"
                    ),
                    remediation=_HINTS["incompatible_version"],
                    error_code="incompatible_version",
                    detail={
                        "client_api_version": CLIENT_API_VERSION,
                        "server_api_version": info["api_version"],
                    },
                )
            self._version = info
        return self._version

    @property
    def node(self) -> str:
        return str(self.connect()["node"])

    # -- routes ------------------------------------------------------------
    def get(self, route: str, shape: str, query: dict[str, Any] | None = None) -> Any:
        self.connect()
        return self._json("GET", route + _query(query), shape)

    def post(self, route: str, shape: str, body: dict[str, Any]) -> Any:
        self.connect()
        return self._json("POST", route, shape, body)

    # -- attach ------------------------------------------------------------
    def attach(self, run_id: str, after: int = 0) -> Iterator[dict[str, Any]]:
        """Yield events after cursor *after* until the run's terminal state event.

        A stream that breaks is reopened with ``after`` set to the last cursor
        received (the contract's reconnect rule), so nothing is skipped or
        repeated. Gives up with ``unavailable`` after repeated reconnects that
        make no progress.
        """
        self.connect()
        cursor, stalled = after, 0
        route = f"/v1/runs/{quote(run_id, safe='')}"
        while True:
            progressed = False
            try:
                for event in self._stream_once(f"{route}/attach{_query({'after': cursor})}"):
                    cursor, progressed = event["cursor"], True
                    yield event
                    if _is_terminal(event):
                        return
            except CoreError:
                raise
            except (OSError, http.client.HTTPException):
                pass  # a broken stream is retried below
            if not progressed:
                run = self._json("GET", route, "run")
                if run["terminal"] and run["cursor"] <= cursor:
                    return  # already finished and fully replayed: nothing more to send
                stalled += 1
                if stalled > _MAX_STALLED_RECONNECTS:
                    raise _unavailable(self.path, "the event stream keeps closing without events")
                time.sleep(min(0.2 * stalled, 1.0))
            else:
                stalled = 0

    def _stream_once(self, route: str) -> Iterator[dict[str, Any]]:
        conn, resp = self._open("GET", route, timeout=_STREAM_TIMEOUT)
        try:
            if resp.status != 200:
                parsed = _loads(resp.read())
                raise error_from_body(resp.status, parsed)
            yield from _parse_sse(resp)
        finally:
            conn.close()


def _describe(exc: BaseException) -> str:
    if isinstance(exc, FileNotFoundError):
        return "no such socket (is the core running?)"
    if isinstance(exc, ConnectionRefusedError):
        return "connection refused (is the core running?)"
    if isinstance(exc, PermissionError):
        return "permission denied (the socket is owner-only)"
    if isinstance(exc, socket.timeout):
        return "timed out"
    return f"{exc.__class__.__name__}: {exc}" if str(exc) else exc.__class__.__name__


def _query(params: dict[str, Any] | None) -> str:
    items = {k: v for k, v in (params or {}).items() if v is not None}
    return "?" + urlencode(items) if items else ""


def _loads(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, ValueError):
        return None


def _is_terminal(event: dict[str, Any]) -> bool:
    data = event["data"]
    return event["kind"] == "run.state" and data.get("to") in _TERMINAL_STATES


def _parse_sse(resp: http.client.HTTPResponse) -> Iterator[dict[str, Any]]:
    """Parse ``id:/event:/data:`` messages separated by blank lines.

    Comment lines (``: keepalive``) are ignored. The payload is the ``data``
    JSON, whose own ``kind`` and ``cursor`` are authoritative.
    """
    data_lines: list[str] = []
    while True:
        line = resp.readline()
        if not line:
            return  # EOF; a half-received message is dropped and replayed on reconnect
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if text == "":
            if data_lines:
                event = _loads("\n".join(data_lines).encode("utf-8"))
                found = _shapes.check("event", event)
                if found:
                    raise _internal(f"the core sent an invalid event ({found})")
                yield event
            data_lines = []
        elif text.startswith(":"):
            continue
        elif text.startswith("data:"):
            data_lines.append(text[5:].removeprefix(" "))
