"""Shared vocabulary for the per-harness smoke check.

Constants, the :class:`Result` record, and the two source readers (the
invocation contract and the vendored fingerprint registry). The stage modules
and the ``scripts/harness-smoke.py`` driver all build on this module.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

INVOCATIONS_REL = Path("docs") / "harness-invocations.yaml"
FINGERPRINTS_REL = (
    Path(".claude") / "skills" / "agent-config" / "data" / "backend-fingerprints.yaml"
)
CANONICAL_SKILLS_REL = Path(".claude") / "skills"

#: The five harnesses this repo supports, in report order. Keys must match
#: ``harnesses:`` in docs/harness-invocations.yaml exactly — a mismatch in
#: either direction is a hard failure, so a harness can never be silently
#: dropped from the smoke check by editing only one of the two files.
HARNESSES = ("claude", "pi", "qwen", "colleague", "opencode")

#: harness -> the Culture backend it rides. Five harnesses occupy only three
#: backend names: Qwen Code and OpenCode ride ``acp`` (OpenCode speaks ACP via
#: ``opencode acp``), and associate/Pi rides ``colleague``.
#: A harness's config files must be registered under ITS OWN backend in the
#: fingerprint registry, not merely somewhere in it.
HARNESS_BACKEND = {
    "claude": "claude",
    "pi": "colleague",
    "qwen": "acp",
    "colleague": "colleague",
    "opencode": "acp",
}

#: harness -> (``guild create --harness`` name, the prompt file guild seeds).
#: The seeded file is additionally asserted to be one of that harness's
#: ``resolves`` entries in the YAML, so this table cannot drift off the source.
#: A harness with no entry here (OpenCode: ``guild create`` has no harness for
#: it) is reported as SKIP by the toolchain stage, never as a pass.
GUILD_HARNESS = {
    "claude": ("claude", "CLAUDE.md"),
    "pi": ("associate", ".pi/SYSTEM.md"),
    "qwen": ("qwen", "QWEN.md"),
    "colleague": ("colleague", "AGENTS.colleague.md"),
}

#: steward doctor findings we knowingly carry. These are the five pre-existing
#: ``~/.eidetic/memory`` references in two byte-verbatim vendored skills; they
#: are upstream's to fix (never patch a verbatim vendored copy), so they are
#: WAIVED — reported every run, never silently dropped. Any finding outside
#: this allowlist fails the check.
#:
#: The issue-2 devague records are waived for a different reason: their
#: confirmed claims and scope findings name the workspace root by its absolute
#: path. devague state is never hand-edited, and amending a confirmed claim
#: sends it back to the owner, so the frame, the plan and their three exports
#: keep the owner-confirmed wording.
_ISSUE_2 = "issue-2-cross-repo-reorganization"
STEWARD_WAIVED_PORTABILITY_PATHS = frozenset(
    {
        ".claude/skills/recall/SKILL.md",
        ".claude/skills/remember/SKILL.md",
        f".devague/frames/{_ISSUE_2}.json",
        f".devague/plans/{_ISSUE_2}.json",
        f"docs/specs/2026-11-24-{_ISSUE_2}.md",
        f"docs/plans/2026-11-24-{_ISSUE_2}.md",
        f"docs/plans/2026-11-24-{_ISSUE_2}-split.md",
    }
)

PASS, FAIL, SKIP, WAIVED = "PASS", "FAIL", "SKIP", "WAIVED"


class Result:
    """One check outcome."""

    def __init__(self, stage: str, name: str, status: str, detail: str) -> None:
        self.stage = stage
        self.name = name
        self.status = status
        self.detail = detail

    @property
    def label(self) -> str:
        return f"{self.stage}/{self.name}"

    def as_dict(self) -> dict[str, str]:
        return {
            "stage": self.stage,
            "check": self.name,
            "status": self.status,
            "detail": self.detail,
        }


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------


def load_invocations(repo: Path) -> dict[str, Any]:
    """Read the single source of truth for the harness invocations."""
    path = repo / INVOCATIONS_REL
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    harnesses = data.get("harnesses") or {}
    if set(harnesses) != set(HARNESSES):
        raise SystemExit(
            f"error: {INVOCATIONS_REL} lists harnesses {sorted(harnesses)}, "
            f"but this check knows {sorted(HARNESSES)}. Teach the check about "
            "the change rather than letting a harness go unchecked."
        )
    return harnesses


def registry_prompts_by_backend(repo: Path) -> dict[str, tuple[str, ...]]:
    """``backend -> accepted prompt paths`` from the vendored registry.

    Returns an empty mapping when the registry is absent or unreadable — the
    ``fingerprint-registry`` config check reports that, and every harness then
    fails on "not registered" rather than the run dying with a traceback.
    """
    path = repo / FINGERPRINTS_REL
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return {}
    mapping: dict[str, tuple[str, ...]] = {}
    for backend, entry in (data.get("backends") or {}).items():
        prompt = (entry or {}).get("prompt")
        if isinstance(prompt, str):
            mapping[str(backend)] = (prompt,)
        elif isinstance(prompt, list):
            mapping[str(backend)] = tuple(str(p) for p in prompt)
    return mapping
