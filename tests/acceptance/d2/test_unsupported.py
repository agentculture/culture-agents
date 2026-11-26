"""Part one still refuses pause, resume, artifacts and delegation, and says so.

Steer is not preemption (it is delivered into the running turn), so these stay refused
until part two or later. The real core, the stub harness, raw requests over its socket.
"""

from __future__ import annotations

import json
import socket
from typing import Any

from tests.acceptance.d1.support import AGENT, Core
from tests.acceptance.d2.conftest import MakeCore


def _http(core: Core, method: str, path: str, body: Any = None) -> tuple[int, dict[str, Any]]:
    payload = json.dumps(body if body is not None else {}).encode()
    head = f"{method} {path} HTTP/1.1\r\nHost: core\r\nAgents-Api-Version: 3.0\r\n"
    head += f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    with sock:
        sock.connect(str(core.socket))
        sock.sendall(head.encode() + b"Connection: close\r\n\r\n" + payload)
        raw = b""
        while chunk := sock.recv(65536):
            raw += chunk
    top, _, rest = raw.partition(b"\r\n\r\n")
    return int(top.split(b" ", 2)[1]), json.loads(rest or b"{}")


def test_pause_resume_artifacts_and_delegation_still_answer_unsupported(
    make_core: MakeCore,
) -> None:
    core = make_core()
    repo = core.add_repo()
    run, _ = core.submit("stub", repo, "hang")
    core.wait_run(run["id"], lambda r: r["state"] == "running", "running", 10)
    caller = {"kind": "operator", "id": "thor-operator"}

    for action in ("pause", "resume"):
        status, body = _http(core, "POST", f"/v1/runs/{run['id']}/{action}", {"caller": caller})
        assert status == 422, (action, status, body)
        assert body["error"]["code"] == "unsupported"
        assert body["error"]["capability"] == action

    doc = _http(core, "GET", "/v1/harnesses/stub")[1]["capabilities"]
    for name in ("pause", "resume", "delegate"):
        assert doc[name]["supported"] is False, name

    submit = {"agent_id": AGENT, "harness": "stub", "repo": str(repo), "task": "files: a.txt"}
    status, body = _http(
        core,
        "POST",
        "/v1/runs",
        {**submit, "caller": caller, "parent_run_id": run["id"]},
    )
    assert (status, body["error"]["code"]) == (422, "unsupported"), body
    assert body["error"]["capability"] == "delegate"

    status, _ = _http(core, "GET", f"/v1/runs/{run['id']}/artifacts")
    assert status == 404, "no artifacts route exists"
    ran = core.cli("runs", "artifacts", run["id"])
    assert ran.rc != 0, "no artifacts verb exists"
    core.ok("runs", "cancel", run["id"])
