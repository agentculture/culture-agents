"""The steward portability waiver accepts known lines only, never a whole record file."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from _harness_smoke.toolchain_stage import _portability_waived  # noqa: E402

FRAME = ".devague/frames/issue-2-cross-repo-reorganization.json"
HEAD = "Hard-coded /home/<user>/ paths:"


def _message(*lines: str) -> str:
    return "\n".join([HEAD, *(f"    {line}" for line in lines)])


def test_the_workspace_root_and_its_prompt_file_are_accepted_in_the_records() -> None:
    assert _portability_waived(
        _message(
            f'{FRAME}:362:      "text": "The /home/op/git/CLAUDE.md file is rewritten.",',
            f'{FRAME}:1151:      "surface": "/home/op/git sibling checkouts (survey)",',
            ".claude/skills/recall/SKILL.md:12: the store lives under ~/.eidetic/memory",
        )
    )


def test_any_other_home_path_in_a_record_is_still_a_finding() -> None:
    for content in (
        '"text": "copy /home/op/git/culture/secrets.env"',
        '"text": "key at /home/op/.ssh/id_ed25519"',
        '"text": "/home/op/git/CLAUDE.md and /home/op/git/culture-agents/x"',
        '"text": "no home path on this flagged line at all"',
    ):
        assert not _portability_waived(_message(f"{FRAME}:9:      {content}")), content


def test_a_file_outside_the_two_lists_is_never_waived() -> None:
    assert not _portability_waived(_message("docs/d0/probe.md:3: see /home/op/git"))
    assert not _portability_waived(HEAD), "a finding with no parsable line is not waived"
