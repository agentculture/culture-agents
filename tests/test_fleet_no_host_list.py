"""t22 acceptance 3: no host list exists in any tracked file.

The fleet member list is built from announcements only. The one place a core keeps peer
addresses is a local, untracked file in the user's config directory
(``culture-agents/fleet/peers.json``), beside the untracked trust list. This test holds the
repository to that: no tracked file has either name, and no tracked file holds an address with a
port other than loopback, the unspecified address, or a documentation range that names no host.
"""

from __future__ import annotations

import ipaddress
import re
import subprocess  # nosec B404 - fixed git invocation only
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Not checked: throwaway probe evidence, vendored kits and records, and the secret scan's own
#: test, which must spell out a failing endpoint.
EXCLUDED_PREFIXES = ("spikes/", ".claude/skills/", ".devague/", "docs/specs/", "docs/plans/")
EXCLUDED_FILES = {"tests/test_scan_secrets.py"}
ADDRESS = re.compile(r"(?<![\d.])((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?![\d.])")
DOCUMENTATION = [
    ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
]


def _tracked() -> list[str]:
    out = subprocess.run(  # nosec B603 B607
        ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout
    return [p for p in out.splitlines() if p and not p.startswith(EXCLUDED_PREFIXES)]


def _names_a_host(text: str) -> bool:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return False  # not an address (a version string, an OID)
    if ip.is_loopback or ip.is_unspecified:
        return False
    return not any(ip in net for net in DOCUMENTATION)


def test_no_tracked_file_is_an_address_list_or_a_trust_list() -> None:
    names = {Path(p).name for p in _tracked()}
    assert "peers.json" not in names
    assert "trust.json" not in names


def test_no_tracked_file_holds_an_address_that_names_a_host() -> None:
    found = []
    for rel in _tracked():
        if rel in EXCLUDED_FILES:
            continue
        try:
            text = (REPO_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        found += [(rel, m.group(0)) for m in ADDRESS.finditer(text) if _names_a_host(m.group(1))]
    assert found == []


def test_the_core_reads_peer_addresses_only_from_the_local_config_directory() -> None:
    source = (REPO_ROOT / "core" / "src" / "fleet" / "peers.ts").read_text(encoding="utf-8")
    assert 'join(resolveTrustPath(env), "..", "peers.json")' in source
    config = (REPO_ROOT / "core" / "src" / "fleet" / "config.ts").read_text(encoding="utf-8")
    assert 'join(dirname(path), "peers.json")' in config
