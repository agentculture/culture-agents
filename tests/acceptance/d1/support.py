"""A real core daemon in a temp directory, and the real ``agents`` CLI against it."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess  # nosec B404 - the suite's job is to run the real binaries
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, NamedTuple

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DAEMON_JS = REPO_ROOT / "core" / "dist" / "src" / "daemon" / "main.js"
NODE = "spark"
AGENT = f"{NODE}-tester"
STATES = {
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "unknown",
}
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "unknown"}
REQUIRE_ENV = "CULTURE_AGENTS_ACCEPTANCE_REQUIRE"
REPORT_ENV = "CULTURE_AGENTS_ACCEPTANCE_REPORT"


def not_verified(reason: str) -> None:
    """Skip with the wording the smoke stages use; a skipped check is never a pass."""
    pytest.skip(f"NOT VERIFIED: {reason}")


def require_core_build() -> None:
    """The mock stage needs Node and a built core; CI sets ``REQUIRE_ENV`` so a miss fails."""
    missing = None
    if shutil.which("node") is None:
        missing = "node is not on PATH"
    elif not DAEMON_JS.is_file():
        missing = f"the core is not built ({DAEMON_JS.relative_to(REPO_ROOT)} is missing; run "
        missing += "'npm ci && npm run build' in core/)"
    if missing is None:
        return
    if os.environ.get(REQUIRE_ENV) == "1":
        pytest.fail(f"D1 acceptance cannot run: {missing}")
    not_verified(missing)


def record(check: str, **data: Any) -> None:
    """Append one measurement to the report file, when one is requested."""
    path = os.environ.get(REPORT_ENV)
    if not path:
        return
    line = json.dumps(
        {"check": check, "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **data}
    )
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


class Ran(NamedTuple):
    rc: int
    out: str
    err: str
    seconds: float

    def json(self) -> Any:
        return json.loads(self.out)

    def error_code(self) -> str | None:
        try:
            return json.loads(self.err).get("error_code")
        except (ValueError, AttributeError):
            return None


def _git(repo: Path, *args: str) -> str:
    res = subprocess.run(  # nosec B603 B607
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    )
    return res.stdout.strip()


def _proc_alive(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return False
    return stat.rsplit(")", 1)[-1].split()[0] != "Z"


def wait_for(what: str, probe: Callable[[], Any], timeout: float, every: float = 0.1) -> Any:
    """Poll *probe* until it returns something truthy; fail naming *what* on timeout."""
    deadline = time.monotonic() + timeout
    while True:
        value = probe()
        if value:
            return value
        if time.monotonic() >= deadline:
            pytest.fail(f"timed out after {timeout:.0f} s waiting for {what}")
        time.sleep(every)


class Core:
    """One core daemon with its own socket, state directory, allow-list and repositories."""

    def __init__(self, harnesses: list[str], config: dict[str, Any], *, live: bool = False):
        # Unix socket paths are limited to ~108 bytes; keep this directory short.
        self.root = Path(tempfile.mkdtemp(prefix="ca-acc-"))
        self.live = live
        self.harnesses = harnesses
        self.socket = self.root / "core.sock"
        self.state_dir = self.root / "state"
        self.config_home = self.root / "config"
        self.stderr_path = self.root / "daemon.err"
        self.proc: subprocess.Popen[bytes] | None = None
        self.repos: list[Path] = []
        (self.config_home / "culture-agents").mkdir(parents=True)
        (self.config_home / "culture-agents" / "harness.json").write_text(json.dumps(config))
        (self.root / "server.yaml").write_text(f"server:\n  name: {NODE}\n")
        self.env = self._environment()

    def _environment(self) -> dict[str, str]:
        keep = {k: v for k, v in os.environ.items() if not k.startswith("CULTURE_AGENTS_")}
        env = {
            **keep,
            "CULTURE_AGENTS_SOCKET": str(self.socket),
            "CULTURE_AGENTS_STATE_DIR": str(self.state_dir),
            "CULTURE_SERVER_YAML": str(self.root / "server.yaml"),
            "XDG_CONFIG_HOME": str(self.config_home),
        }
        if self.live:
            # The openshell CLI keeps its gateway registration under the config home.
            source = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
            if (source / "openshell").is_dir():
                (self.config_home / "openshell").symlink_to(source / "openshell")
        else:
            # Nothing of the operator's is readable: no ~/.culture, no mesh config, no gateway.
            env["HOME"] = str(self.root)
            env.pop("OPENSHELL_LOCAL_TLS_DIR", None)
        return env

    # -- repositories and the allow-list ---------------------------------------------------

    def add_repo(self) -> Path:
        """A fresh git repository on ``main`` with one commit, allowed for every harness."""
        repo = self.root / f"repo{len(self.repos)}"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / "README").write_text("acceptance repo\n")
        _git(repo, "add", "README")
        _git(repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "one")
        self.repos.append(repo)
        entries = [
            {"agent_id": AGENT, "harness": h, "repo": str(r)}
            for r in self.repos
            for h in self.harnesses
        ]
        allowlist = self.config_home / "culture-agents" / "allowlist.json"
        allowlist.write_text(json.dumps({"version": 1, "entries": entries}))
        return repo

    # -- the daemon process ----------------------------------------------------------------

    def start(self) -> None:
        before = len(self.stderr())
        with open(self.stderr_path, "ab") as err:
            self.proc = subprocess.Popen(  # nosec B603 B607
                ["node", str(DAEMON_JS)], env=self.env, stdout=subprocess.DEVNULL, stderr=err
            )
        proc = self.proc

        def listening() -> bool:
            if proc.poll() is not None:
                pytest.fail(f"the core exited ({proc.returncode}): {self.stderr()}")
            return "listening on" in self.stderr()[before:]  # this start's line, not an earlier one

        wait_for("the core to listen", listening, 15)

    def stderr(self) -> str:
        if not self.stderr_path.exists():
            return ""
        return self.stderr_path.read_text(encoding="utf-8", errors="replace")

    def kill9(self) -> None:
        assert self.proc is not None
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait(10)
        self.proc = None

    def worker_pids(self) -> list[int]:
        pids = []
        for file in self.state_dir.glob("runs/*/worker.json"):
            try:
                pids.append(int(json.loads(file.read_text())["pid"]))
            except (OSError, ValueError, KeyError):
                continue
        return [pid for pid in pids if _proc_alive(pid)]

    def close(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        for pid in self.worker_pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.root, ignore_errors=True)

    # -- the CLI ---------------------------------------------------------------------------

    def cli(self, *argv: str, timeout: float = 60) -> Ran:
        """Run the real ``agents`` CLI in its own process against this core."""
        start = time.monotonic()
        res = subprocess.run(  # nosec B603
            [sys.executable, "-m", "culture_agents", *argv],
            env=self.env,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return Ran(res.returncode, res.stdout, res.stderr, time.monotonic() - start)

    def ok(self, *argv: str) -> Any:
        ran = self.cli(*argv, "--json")
        assert ran.rc == 0, f"agents {' '.join(argv)} exited {ran.rc}: {ran.err}"
        return ran.json()

    def submit(self, harness: str, repo: Path, task: str) -> tuple[dict[str, Any], float]:
        ran = self.cli(
            *("runs", "submit", "--agent", AGENT, "--harness", harness),
            *("--repo", str(repo), "--task", task, "--json"),
        )
        assert ran.rc == 0, f"submit exited {ran.rc}: {ran.err}"
        return ran.json()["run"], ran.seconds

    def show(self, run_id: str) -> dict[str, Any]:
        return self.ok("runs", "show", run_id)

    def wait_run(
        self, run_id: str, want: Callable[[dict[str, Any]], bool], what: str, timeout: float
    ):
        last: dict[str, Any] = {}

        def probe() -> bool:
            last.update(self.show(run_id))
            return want(last)

        wait_for(f"run {run_id} to be {what}", probe, timeout, every=0.2)
        return last

    def wait_terminal(self, run_id: str, timeout: float) -> dict[str, Any]:
        return self.wait_run(run_id, lambda r: r["terminal"], "terminal", timeout)

    def events(self, run_id: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        after = 0
        while True:
            page = self.ok("runs", "logs", run_id, "--after", str(after), "--limit", "5000")
            events.extend(page["events"])
            if not page["more"]:
                return events
            after = page["last_cursor"]

    def outputs(self, run_id: str, channel: str) -> list[dict[str, Any]]:
        return [
            e["data"]
            for e in self.events(run_id)
            if e["kind"] == "run.output" and e["data"]["channel"] == channel
        ]

    def wait_outputs(self, run_id: str, channel: str, count: int, timeout: float) -> None:
        def probe() -> bool:
            run = self.show(run_id)
            if run["terminal"]:
                pytest.fail(f"run {run_id} ended ({run['state']}) before {count} {channel} events")
            return len(self.outputs(run_id, channel)) >= count

        wait_for(f"{count} {channel} event(s) of {run_id}", probe, timeout, every=0.5)


def states(events: list[dict[str, Any]]) -> list[str]:
    return [e["data"]["to"] for e in events if e["kind"] == "run.state"]


def branch_files(repo: Path, run_id: str) -> list[str]:
    """Files on ``runs/<id>`` in the host repository (empty when the branch does not exist)."""
    try:
        return _git(repo, "ls-tree", "--name-only", f"runs/{run_id}").split("\n")
    except subprocess.CalledProcessError:
        return []


def host_untouched(repo: Path) -> bool:
    """The host checkout is still on ``main`` with nothing changed or added."""
    return (
        _git(repo, "symbolic-ref", "--short", "HEAD") == "main"
        and _git(repo, "status", "--porcelain") == ""
    )
