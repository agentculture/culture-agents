"""The verb surface, described once.

``learn``, ``overview`` and ``cli overview`` all list the CLI's verbs. They
read them from here, which reads the agentfront registry, so a verb added to
the registry shows up everywhere and no listing can drift from the code.
"""

from __future__ import annotations

from agentfront import App

#: The meta-verbs agentfront reserves; their behaviour is ours (see ``_app``).
META_VERBS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("learn",), "structured self-teaching prompt"),
    (("explain",), "markdown docs for a noun/verb path"),
    (("overview",), "descriptive snapshot of the agent"),
    (("doctor",), "check the agent-identity invariants"),
)


def verbs(app: App) -> list[tuple[tuple[str, ...], str]]:
    """Every verb path with its one-line summary: meta-verbs, then registered tools."""
    found = list(META_VERBS)
    found.extend((tool.group + (tool.name,), tool.description) for tool in app.list_tools())
    return found


def verb_lines(app: App) -> list[str]:
    return [f"{' '.join(path)} - {summary}" for path, summary in verbs(app)]
