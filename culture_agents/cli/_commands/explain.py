"""``agents explain <path>...`` — global markdown catalog lookup (stable-contract).

``explain`` is global (not nested under a noun). It takes zero or more path
tokens and resolves them via the catalog in :mod:`culture_agents.explain`.
Unknown paths raise :class:`CliError` with a remediation hint.
"""

from __future__ import annotations

import argparse

from culture_agents.cli._output import emit_result
from culture_agents.explain import resolve


def cmd_explain(args: argparse.Namespace) -> int:
    path = tuple(args.path) if args.path else ()
    markdown = resolve(path)
    json_mode = bool(getattr(args, "json", False))
    if json_mode:
        emit_result({"path": list(path), "markdown": markdown}, json_mode=True)
    else:
        emit_result(markdown, json_mode=False)
    return 0
