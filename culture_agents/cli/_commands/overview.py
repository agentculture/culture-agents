"""``agents overview`` — read-only descriptive snapshot of the agent.

Describes the agent to an agent reader: identity (from culture.yaml), the verb
surface (read from the registry), and the artifacts that make up the repo. The
shared section/render helpers here are reused by the ``cli`` noun's
``overview`` (see :mod:`culture_agents.cli._commands.cli`).

Descriptive verbs never hard-fail on a missing target path — an optional
positional ``target`` is accepted and ignored (overview describes this agent,
not an external target), so ``overview <bogus-path>`` still exits 0.
"""

from __future__ import annotations

import argparse

from culture_agents.cli import _surface
from culture_agents.cli._commands.whoami import report
from culture_agents.cli._output import emit_result

_ARTIFACTS = [
    "culture.yaml + AGENTS.colleague.md — mesh identity (suffix + backend)",
    ".claude/skills/ — the canonical guildmaster skill kit (cite-don't-import)",
    "contract/ — the control-API contract the core serves and this CLI consumes",
    "docs/skill-sources.md — skill provenance ledger",
    "pyproject.toml + .github/workflows/ — buildable, deployable package baseline",
]


def agent_sections(app) -> list[dict[str, object]]:
    """Sections describing the agent (used by the global verb)."""
    ident = report()
    return [
        {
            "title": "Identity",
            "items": [
                f"nick: {ident['nick']}",
                f"version: {ident['version']}",
                f"backend: {ident['backend']}",
                f"model: {ident['model']}",
            ],
        },
        {"title": "Verbs", "items": _surface.verb_lines(app)},
        {"title": "Artifacts", "items": list(_ARTIFACTS)},
    ]


def cli_sections(app) -> list[dict[str, object]]:
    """Sections describing the CLI surface itself (used by `cli overview`)."""
    return [
        {"title": "Verbs", "items": _surface.verb_lines(app)},
        {
            "title": "Conventions",
            "items": [
                "every command supports --json",
                "results to stdout, errors/diagnostics to stderr (never mixed)",
                "exit codes: 0 success, 1 user error, 2 environment error, 3+ reserved",
                "runs and agents verbs need the core daemon on its Unix socket",
            ],
        },
    ]


def render_text(subject: str, sections: list[dict[str, object]]) -> str:
    lines = [f"# {subject}", ""]
    for section in sections:
        lines.append(f"## {section['title']}")
        for item in section["items"]:
            lines.append(f"- {item}")
        lines.append("")
    return "\n".join(lines).rstrip()


def emit_overview(subject: str, sections: list[dict[str, object]], *, json_mode: bool) -> None:
    if json_mode:
        emit_result({"subject": subject, "sections": sections}, json_mode=True)
    else:
        emit_result(render_text(subject, sections), json_mode=False)


def cmd_overview(args: argparse.Namespace) -> int:
    # The positional is accepted for rubric compatibility (descriptive verbs
    # must not hard-fail on a missing path) but overview describes this agent.
    from culture_agents.cli._app import get_app

    emit_overview("agents", agent_sections(get_app()), json_mode=bool(getattr(args, "json", False)))
    return 0
