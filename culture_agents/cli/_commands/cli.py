"""``agents cli overview`` — noun grouping CLI-surface introspection.

Exists to satisfy the agent-first rubric's ``overview_cli_noun_exists`` check:
any noun with action-verbs must also expose ``overview``. ``cli overview``
describes the CLI surface (distinct from the global ``overview``, which
describes the agent).
"""

from __future__ import annotations

from culture_agents.cli._commands.overview import cli_sections, render_text
from culture_agents.cli._render import Rendered


def cli_overview() -> Rendered:
    """Describe the agents CLI surface."""
    from culture_agents.cli._app import get_app

    sections = cli_sections(get_app())
    return Rendered(
        {"subject": "agents cli", "sections": sections}, render_text("agents cli", sections)
    )
