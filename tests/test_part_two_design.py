"""The D2 part two design record (task t20) is complete, backed by probes, and names no host.

The record, ``docs/d2/part-two-design.md``, is a decision document for the owner. These tests
hold it to the acceptance criteria of t20: each choice has its options, a recommendation, a
probe with committed evidence, a cost and what would change it; the detection times it states
are the numbers the announcement probe ran with and met; it answers repository identity and the
base commit of a remote run; it carries no real host name, address or per-user path; and it
says whether the owner has approved it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
RECORD = REPO / "docs" / "d2" / "part-two-design.md"
PROBES = REPO / "spikes" / "d2-part-two"

# Each decision the record must make, by the heading that opens its section.
DECISIONS = (
    "Decision 1: the transport between cores",
    "Decision 2: where a core's private key lives and how it reaches the core",
    "Decision 3: how a core announces itself and is dropped",
    "Decision 4: what makes two checkouts the same repository",
    "Decision 5: which commit a remote run starts from",
)
# The parts every decision section must have.
PARTS = ("Options", "Recommendation", "Probe", "Cost", "What would change it")
PROBE_FILES = ("transport-probe.mjs", "key-probe.mjs", "announce-probe.mjs", "repo-probe.mjs")
EVIDENCE = ("transport", "key", "announce", "repo")


def _text() -> str:
    return RECORD.read_text(encoding="utf-8")


def _section(text: str, heading: str) -> str:
    start = text.index(f"## {heading}")
    nxt = text.find("\n## ", start + 1)
    return text[start : nxt if nxt != -1 else len(text)]


def _evidence(name: str) -> list[dict]:
    path = PROBES / "evidence" / f"{name}.ndjson"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _event(name: str, event: str) -> dict:
    return next(e for e in _evidence(name) if e["event"] == event)


def test_the_record_exists():
    assert RECORD.is_file()


@pytest.mark.parametrize("heading", DECISIONS)
def test_each_decision_has_options_a_recommendation_a_probe_a_cost_and_a_trigger(heading):
    section = _section(_text(), heading)
    for part in PARTS:
        assert re.search(rf"^\*\*{re.escape(part)}", section, re.MULTILINE), (heading, part)


@pytest.mark.parametrize("probe", PROBE_FILES)
def test_every_probe_the_record_cites_is_committed_and_named_with_its_command(probe):
    assert (PROBES / probe).is_file()
    assert f"node spikes/d2-part-two/{probe}" in _text()


@pytest.mark.parametrize("name", EVIDENCE)
def test_every_probe_left_evidence(name):
    assert len(_evidence(name)) >= 3
    assert f"spikes/d2-part-two/evidence/{name}.ndjson" in _text()


def test_the_transport_probe_shows_mutual_refusal_and_nothing_secret_on_the_wire():
    assert _event("transport", "case_trusted_pair")["status"] == 200
    assert _event("transport", "case_capture")["any_found"] is False
    unknown = _event("transport", "case_unknown_client")
    assert unknown["requests_served_after"] == unknown["requests_served_before"]
    assert _event("transport", "case_unknown_server")["b_side"] == "call_refused"
    assert _event("transport", "case_revoked")["b_side"] == "call_refused"
    assert _event("transport", "case_session_ticket")["fleet_server_no_ticket"]["resumed"] is False


def test_the_key_probe_shows_the_key_never_reaches_a_worker():
    for case in ("case_env_one_line", "case_env_pem", "case_pipe_fd3", "case_file_0600"):
        result = _event("key", case)
        assert result["signature_verifies"] is True, case
        assert result["worker"]["inEnv"] is False, case
    assert "refused" in _event("key", "case_file_0644")


def test_the_stated_seconds_are_the_numbers_the_announcement_probe_ran_with_and_met():
    stated = _event("announce", "stated_numbers")
    text = _section(_text(), DECISIONS[2])
    assert f"every {stated['interval_s']} seconds" in text
    assert f"{stated['silence_s']} seconds" in text
    assert f"within {stated['silent_detection_bound_s']} seconds" in text
    assert f"within {stated['leave_detection_bound_s']} second" in text
    for case in ("case_stop_sigterm", "case_crash_sigkill", "case_halt_sigstop"):
        assert _event("announce", case)["within_bound"] is True, case
    assert _event("announce", "case_peer_halt_seen_by_b")["within_bound"] is True


def test_the_record_has_a_detection_table_with_a_number_for_each_detection():
    table = _section(_text(), "Detection times")
    rows = [line for line in table.splitlines() if line.startswith("| ") and "---" not in line]
    assert len(rows) >= 5  # header plus at least four detections
    for row in rows[1:]:
        assert re.search(r"\b\d+(\.\d+)? s\b", row), row


def test_the_record_answers_repository_identity_and_the_base_commit_with_a_recommendation():
    for heading in DECISIONS[3:]:
        section = _section(_text(), heading)
        assert "**Recommendation" in section
        assert re.search(r"\b[A-Z]\d\b", section)  # options are labelled (R1, B1 ...)


def test_what_two_hosts_are_needed_for_is_marked_not_verified_for_t28():
    text = _text()
    assert "NOT VERIFIED" in text
    assert "t28" in text
    for item in ("latency", "loss", "clock", "NAT", "firewall"):
        assert item in text, item


def test_open_questions_are_one_list_at_the_end_each_one_line():
    text = _text()
    last_heading = text[text.rindex("\n## ") + 1 :].splitlines()[0]
    assert last_heading == "## Open questions for the owner"
    section = _section(text, "Open questions for the owner")
    items = [line for line in section.splitlines() if re.match(r"^\d+\. ", line)]
    assert len(items) >= 3
    continuations = [line for line in section.splitlines() if line.startswith(" ")]
    assert continuations == [], "each question fits on one line"
    assert all(line.rstrip().endswith("?") for line in items)


def test_the_record_states_the_owner_approval_and_gates_part_two_code_on_it():
    section = _section(_text(), "Owner approval")
    assert re.search(
        r"^Status: (pending|approved [0-9]{4}-[0-9]{2}-[0-9]{2})", section, re.MULTILINE
    )
    for task in ("t21", "t22", "t23", "t24", "t25", "t26"):
        assert task in section, task


_IPV4 = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
_ALLOWED_IPV4 = {"127.0.0.1", "0.0.0.0"}  # nosec B104 - a string compared, not bound
_HOSTY = re.compile(r"\b[\w-]+\.(?:local|lan|home|internal|ts\.net|tailnet)\b", re.IGNORECASE)


def test_the_record_names_no_real_host_address_or_per_user_path():
    text = _text()
    for match in _IPV4.finditer(text):
        assert match.group(0) in _ALLOWED_IPV4, match.group(0)
    hosts = [m.group(0) for m in _HOSTY.finditer(text)]
    assert hosts == [], hosts
    assert "/home/" not in text
    assert not re.search(r"(?:~|\$HOME|\$\{HOME\})/\.", text)
    assert not re.search(r"\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b", text.replace("::1", ""))


def test_the_probe_evidence_names_no_address_but_loopback_and_holds_no_key():
    for name in EVIDENCE:
        raw = (PROBES / "evidence" / f"{name}.ndjson").read_text(encoding="utf-8")
        for match in _IPV4.finditer(raw):
            assert match.group(0) == "127.0.0.1", (name, match.group(0))
        assert "PRIVATE KEY" not in raw
        assert "ed25519:" not in raw
