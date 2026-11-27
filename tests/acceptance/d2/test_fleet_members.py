"""t22: fleet members between two real cores, read through the real ``agents`` CLI (mock stage).

Two built cores run as two processes on loopback, each with its own key, trust list and control
socket. The announcing core is thor's fixture. The core it announces to must hold another node
name, because two members never share one (c40): it uses ``OTHER_NODE``, length-boundary filler
that names no host. The conflict test runs two cores that are both thor, with different keys.

Real seconds are used here, so every bound is generous; the exact 15 s rule is held with an
injected clock in ``core/test/fleet/``.
"""

from __future__ import annotations

import json
import signal
import socket
import subprocess  # nosec B404 - runs the built core's own fleet command
import time
from collections.abc import Iterator

import pytest

from tests.acceptance.d1.support import REPO_ROOT, Core, require_core_build, wait_for
from tests.acceptance.d2.conftest import HERMETIC

FLEET_JS = REPO_ROOT / "core" / "dist" / "src" / "fleet" / "command.js"
OTHER_NODE = "xxxxxxxx"
LOOPBACK = "127.0.0.1"


def _fleet(*argv: str, key: str | None = None) -> str:
    env = {"PATH": "/usr/bin:/bin:/usr/local/bin"}
    if key is not None:
        env["CULTURE_AGENTS_FLEET_KEY"] = key
    res = subprocess.run(  # nosec B603 B607
        ["node", str(FLEET_JS), *argv], env=env, capture_output=True, text=True, timeout=30
    )
    assert res.returncode == 0, res.stderr
    return res.stdout.strip()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind((LOOPBACK, 0))
        return int(s.getsockname()[1])


class Member:
    """One core with the fleet transport on: its key, its listen port and its fleet files."""

    def __init__(self, node: str):
        self.key = _fleet("keygen")
        self.entry = json.loads(_fleet("cert", "--node", node, key=self.key))["entry"]
        self.port = _free_port()
        self.core = Core(["stub"], HERMETIC)
        (self.core.root / "server.yaml").write_text(f"server:\n  name: {node}\n")
        self.core.env["CULTURE_AGENTS_FLEET_LISTEN"] = f"{LOOPBACK}:{self.port}"
        self.core.env["CULTURE_AGENTS_FLEET_KEY"] = self.key
        self.fleet_dir = self.core.config_home / "culture-agents" / "fleet"
        self.fleet_dir.mkdir(parents=True)

    def trust(self, *others: Member) -> None:
        (self.fleet_dir / "trust.json").write_text(json.dumps([o.entry for o in others]))

    def announce_to(self, *others: Member) -> None:
        addresses = [f"{LOOPBACK}:{o.port}" for o in others]
        (self.fleet_dir / "peers.json").write_text(json.dumps(addresses))

    def fleet_view(self) -> dict:
        ran = self.core.cli("agents", "list", "--json")
        assert ran.rc == 0, ran.err
        return ran.json()["fleet"]

    def listed(self) -> list[str]:
        return [m["node"] for m in self.fleet_view()["members"]]


@pytest.fixture
def members() -> Iterator[list[Member]]:
    require_core_build()
    made: list[Member] = []
    try:
        yield made
    finally:
        for m in made:
            m.core.close()


def _pair(members: list[Member]) -> tuple[Member, Member]:
    """The core named OTHER_NODE that knows no address, and thor's core that announces to it."""
    listening, announcing = Member(OTHER_NODE), Member("thor")
    members.extend([listening, announcing])
    listening.trust(announcing)
    announcing.trust(listening)
    announcing.announce_to(listening)
    listening.core.start()
    return listening, announcing


def test_each_core_lists_the_other_after_it_announces_and_drops_it_when_it_stops(members) -> None:
    listening, announcing = _pair(members)
    view = listening.fleet_view()
    assert (view["transport"], view["members"]) == ("on", []), "nobody before an announcement"
    assert (view["announce_interval_ms"], view["silence_ms"]) == (5000, 15000)
    announcing.core.start()
    wait_for("the listening core to list thor", lambda: listening.listed() == ["thor"], 20)
    wait_for(
        "thor to list the core that knows no address",
        lambda: announcing.listed() == [OTHER_NODE],
        20,
    )
    member = listening.fleet_view()["members"][0]
    assert member["api_version"] == "3.3"
    assert announcing.entry["cert"] not in json.dumps(listening.fleet_view()), "no key material"

    announcing.core.close()  # SIGTERM: a clean stop announces leaving before the process exits
    gone = time.monotonic()
    wait_for("thor to leave the list", lambda: listening.listed() == [], 10)
    assert time.monotonic() - gone < 10
    assert "member thor left" in listening.core.stderr()


def test_a_core_that_dies_leaves_the_list_by_silence_within_16_seconds(members) -> None:
    listening, announcing = _pair(members)
    announcing.core.start()
    wait_for("the listening core to list thor", lambda: listening.listed() == ["thor"], 20)
    assert announcing.core.proc is not None
    announcing.core.proc.send_signal(signal.SIGKILL)  # no leaving: it stands for a crashed host
    announcing.core.proc.wait(10)
    announcing.core.proc = None
    killed = time.monotonic()
    wait_for("thor to be dropped as silent", lambda: listening.listed() == [], 40)
    took = time.monotonic() - killed
    # Its last announcement came at most 5 s before the kill: dropped no sooner than 10 s after it.
    assert took >= 9, f"dropped after {took:.1f} s, before its silence could have passed 15 s"
    # A read hides a silent member at once; the sweep, every second, logs the drop.
    wait_for(
        "the drop in the log", lambda: "member thor dropped: silent" in listening.core.stderr(), 5
    )


def test_a_second_core_with_thors_name_and_another_key_is_refused_and_reported(members) -> None:
    first, second = Member("thor"), Member("thor")
    members.extend([first, second])
    first.trust(second)  # the operator trusted the second key under thor's own name
    second.trust(first)
    second.announce_to(first)
    first.core.start()
    second.core.start()
    wait_for("the refusal in the member list", lambda: first.fleet_view()["refused"], 20)
    view = first.fleet_view()
    assert view["members"] == []
    refusal = view["refused"][0]
    assert (refusal["node"], refusal["trusted_as"]) == ("thor", "thor")
    assert "held by this core's own key" in refusal["reason"]
    assert "refused an announcement (conflict)" in first.core.stderr()
    text = first.core.cli("agents", "list")
    assert "refused announcements (1):" in text.out
    wait_for(
        "the second core to log the refusal",
        lambda: "refused this core's announcement (409, conflict" in second.core.stderr(),
        20,
    )
    assert second.listed() == []


def test_a_core_without_the_transport_lists_nobody() -> None:
    require_core_build()
    plain = Core(["stub"], HERMETIC)
    try:
        plain.start()
        ran = plain.cli("agents", "list", "--json")
        assert ran.rc == 0, ran.err
        assert ran.json()["fleet"]["transport"] == "off"
        assert ran.json()["fleet"]["members"] == []
        assert "fleet: transport off" in plain.cli("agents", "list").out
    finally:
        plain.close()
