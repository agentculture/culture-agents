"""A fake core for CLI tests: a stdlib HTTP server on a temporary Unix socket.

It serves the contract's own fixtures (``contract/fixtures/valid``), including
an SSE stream built from ``fixtures/streams/valid``, so the CLI is exercised
against exactly what the contract says the wire looks like. It records every
request, so tests can validate what the CLI *sent* against the schemas.

Per-route behaviour can be replaced with :meth:`FakeCore.respond`; stream
behaviour with ``attach_cutoffs``.
"""

from __future__ import annotations

import json
import re
import socketserver
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from tests import contract_support as cs

VALID = cs.FIXTURES / "valid"
RUN_ID = "spark-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5"
AGENT_ID = "spark-culture-agents"


def fixture(schema: str, name: str) -> Any:
    return cs.load_json(VALID / schema / f"{name}.json")


def error_body(name: str) -> dict:
    return fixture("error", name)


#: route key -> (status, fixture payload). ``{...}`` segments match one path part.
DEFAULTS: dict[str, tuple[int, Any]] = {
    "GET /v1/version": (200, fixture("version", "root.current")),
    "GET /v1/agents": (200, fixture("agent", "agent_list.two-agents")),
    "GET /v1/agents/{id}": (200, fixture("agent", "root.running")),
    "GET /v1/harnesses/{id}": (200, fixture("capabilities", "root.opencode-no-steer")),
    "POST /v1/runs": (201, fixture("control-action", "submit_response.queued")),
    "GET /v1/runs": (200, fixture("run", "run_list.two-runs")),
    "GET /v1/runs/{id}": (200, fixture("run", "root.running")),
    "GET /v1/runs/{id}/events": (200, fixture("event", "event_page.first-page")),
    "GET /v1/runs/{id}/result": (200, fixture("run", "run_result.succeeded")),
    "POST /v1/runs/{id}/steer": (202, fixture("control-action", "accepted_response.steer")),
    "POST /v1/runs/{id}/cancel": (202, fixture("control-action", "accepted_response.cancel")),
}

_PATTERNS = [
    (key, re.compile("^" + re.sub(r"\{id\}", "[^/]+", key.split(" ", 1)[1]) + "$"))
    for key in DEFAULTS
]


def stream_events(name: str = "succeeded") -> list[dict]:
    return cs.read_stream(cs.FIXTURES / "streams" / "valid" / f"{name}.jsonl")


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    core: FakeCore


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:  # keep test output clean
        pass

    def _route(self, method: str) -> None:
        core = self.server.core  # type: ignore[attr-defined]
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        body = json.loads(raw) if raw else None
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        core.requests.append(
            {
                "method": method,
                "path": parts.path,
                "query": query,
                "body": body,
                "version_header": self.headers.get("Agents-Api-Version"),
            }
        )
        if parts.path.endswith("/attach") and method == "GET":
            return self._attach(core, query)
        if (
            parts.path.startswith("/v1/harnesses/")
            and "GET /v1/harnesses/{id}" not in core.overrides
        ):
            name = parts.path.rsplit("/", 1)[1]
            docs = {"claude-code": "root.claude-code", "opencode": "root.opencode-no-steer"}
            if name not in docs:
                return self._json(404, error_body("root.not-found"))
            return self._json(200, fixture("capabilities", docs[name]))
        for key, pattern in _PATTERNS:
            if key.split(" ", 1)[0] == method and pattern.match(parts.path):
                status, payload = core.overrides.get(key, DEFAULTS[key])
                return self._json(status, payload)
        self._json(404, error_body("root.not-found"))

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _attach(self, core: FakeCore, query: dict[str, str]) -> None:
        if "attach" in core.overrides_by_name:
            status, payload = core.overrides_by_name["attach"]
            return self._json(status, payload)
        after = int(query.get("after", 0))
        pending = [e for e in core.events if e["cursor"] > after]
        if core.attach_cutoffs:
            cutoff = core.attach_cutoffs.pop(0)
            if cutoff is not None:
                pending = pending[:cutoff]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(b": keepalive\n\n")
        for event in pending:
            frame = f"id: {event['cursor']}\nevent: {event['kind']}\ndata: {json.dumps(event)}\n\n"
            self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")


class FakeCore:
    """Serve the contract fixtures on ``socket_path`` until :meth:`close`."""

    def __init__(self, socket_path: Path) -> None:
        self.socket_path = socket_path
        self.requests: list[dict[str, Any]] = []
        self.overrides: dict[str, tuple[int, Any]] = {}
        self.overrides_by_name: dict[str, tuple[int, Any]] = {}
        self.events = stream_events()
        #: One entry per attach connection: send at most N events, then close.
        self.attach_cutoffs: list[int | None] = []
        self._server = _Server(str(socket_path), _Handler)
        self._server.core = self
        self._thread = threading.Thread(
            target=lambda: self._server.serve_forever(poll_interval=0.01), daemon=True
        )
        self._thread.start()

    def respond(self, key: str, status: int, payload: Any) -> None:
        """Replace one route's answer (``key`` like ``"POST /v1/runs"``, or ``attach``)."""
        if key == "attach":
            self.overrides_by_name[key] = (status, payload)
        else:
            self.overrides[key] = (status, payload)

    def seen(self, method: str, path: str) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["method"] == method and r["path"] == path]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
