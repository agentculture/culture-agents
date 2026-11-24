"""``agents learn`` — the learnability affordance.

Prints a structured self-teaching prompt. Must satisfy the agent-first rubric:
>=200 chars and mention purpose, command map, exit codes, --json, and explain.
The command map is generated from the registry (see ``_surface``).
"""

from __future__ import annotations

import argparse

from culture_agents import __version__
from culture_agents.cli import _surface
from culture_agents.cli._output import emit_result

_HEAD = """\
agents - the control plane for AgentCulture agents.

Purpose
-------
Direct dispatch, persistent runs and lifecycle control (submit, attach, steer,
cancel) over harness adapters, independent of chat. This CLI is a client of the
core daemon, which owns all run state and talks over a local Unix socket
(CULTURE_AGENTS_SOCKET, else $XDG_RUNTIME_DIR/culture-agents/core.sock). With
the core not running, every `agents` and `runs` verb exits 2 with a hint.

Commands
--------
"""

_TAIL = """
Machine-readable output
-----------------------
Every command supports --json. Errors in JSON mode emit
{"code", "message", "remediation"} to stderr (plus "error_code" and its typed
fields when the core refused the request). Stdout and stderr never mix.
`runs attach --json` prints one event JSON object per line.

Exit-code policy
----------------
  0 success
  1 user-input error (bad flag, bad path, missing arg) or a request the core
    refuses (denied, unsupported, busy, conflict, invalid, not_found)
  2 environment / setup error (core not running, incompatible API version)
  3+ reserved

More detail
-----------
  agents explain agents
  agents explain runs
"""


def _text(app) -> str:
    return _HEAD + "\n".join(f"  agents {line}" for line in _surface.verb_lines(app)) + "\n" + _TAIL


def _as_json_payload(app) -> dict[str, object]:
    return {
        "tool": "agents",
        "version": __version__,
        "purpose": "Control plane for AgentCulture agents: dispatch, runs, lifecycle control.",
        "commands": [
            {"path": list(path), "summary": summary} for path, summary in _surface.verbs(app)
        ],
        "exit_codes": {
            "0": "success",
            "1": "user-input error or a request the core refuses",
            "2": "environment/setup error",
        },
        "json_support": True,
        "explain_pointer": "agents explain <path>",
    }


def cmd_learn(args: argparse.Namespace) -> int:
    from culture_agents.cli._app import get_app

    app = get_app()
    if getattr(args, "json", False):
        emit_result(_as_json_payload(app), json_mode=True)
    else:
        emit_result(_text(app), json_mode=False)
    return 0
