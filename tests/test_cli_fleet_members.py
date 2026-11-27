"""t22: ``agents agents list`` shows the fleet members, from the core's ``fleet.members`` route.

Against the fake core, which serves the contract's own fixtures. The member list is built by the
core from announcements only; the CLI keeps no list of hosts.
"""

from __future__ import annotations

from tests.cli_support import run
from tests.fake_core import fixture


def test_list_text_shows_members_and_refused_announcements(core, capsys) -> None:
    r = run(capsys, "agents", "list")
    assert r.rc == 0, r.err
    assert (
        "fleet: transport on, announcing every 5.0 s, a member silent for 15.0 s is dropped"
        in r.out
    )
    assert "members (1):" in r.out
    assert "  thor  key 3b3b3b3b3b3b3b3b  api 3.1  heard 2.1 s ago" in r.out
    assert "refused announcements (1):" in r.out
    assert "claimed thor by key c7c7c7c7c7c7c7c7 (trusted as thor), 3 time(s)" in r.out
    assert "held by this core's own key" in r.out


def test_list_json_carries_the_member_list_unchanged_under_fleet(core, capsys) -> None:
    r = run(capsys, "agents", "list", "--json")
    assert r.rc == 0
    assert r.json()["fleet"] == fixture("fleet", "root.one-member-one-refusal")
    assert [q["path"] for q in core.requests] == ["/v1/version", "/v1/agents", "/v1/fleet/members"]


def test_a_core_with_the_transport_off_says_so(core, capsys) -> None:
    core.respond("GET /v1/fleet/members", 200, fixture("fleet", "root.off"))
    r = run(capsys, "agents", "list")
    assert r.rc == 0
    assert "fleet: transport off" in r.out
    assert "members (" not in r.out
    assert run(capsys, "agents", "list", "--json").json()["fleet"]["transport"] == "off"


def test_a_member_list_that_breaks_the_contract_is_never_passed_on(core, capsys) -> None:
    bad = fixture("fleet", "root.one-member-one-refusal")
    bad["members"][0]["address"] = "127.0.0.1:7443"  # the list never reports an address
    core.respond("GET /v1/fleet/members", 200, bad)
    r = run(capsys, "agents", "list", "--json")
    assert r.rc == 2
    assert "127.0.0.1:7443" not in r.out


def test_text_from_the_member_list_cannot_reach_the_terminal_raw(core, capsys) -> None:
    doc = fixture("fleet", "root.one-member-one-refusal")
    doc["refused"][0]["reason"] = "line one\nline two\x1b[31m"
    core.respond("GET /v1/fleet/members", 200, doc)
    r = run(capsys, "agents", "list")
    assert r.rc == 0
    assert "\x1b" not in r.out
    assert "line one\nline two" not in r.out
