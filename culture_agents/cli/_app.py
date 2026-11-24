"""The agentfront :class:`App`: the one registry the CLI is derived from.

Every verb is declared once here. agentfront builds the argparse tree, the
``--json`` flag and the nested noun groups from it. Two things stay ours:

* ``learn``, ``explain``, ``overview`` and ``doctor`` are agentfront's reserved
  meta-verbs. Their generic output cannot describe this repo (identity doctor,
  the explain catalog), so :func:`derive_parser` points them at our handlers.
  That is the only place the generated parser is touched.
* Errors are :class:`CliError` (agentfront's ``AgentfrontError``), so
  agentfront's dispatcher renders them and no traceback leaks.
"""

from __future__ import annotations

import argparse
from functools import lru_cache
from typing import Any, Callable

from agentfront import App
from agentfront._registry import Flag

from culture_agents import __version__
from culture_agents.cli._commands import agents as agents_cmd
from culture_agents.cli._commands import cli as cli_cmd
from culture_agents.cli._commands import runs as runs_cmd
from culture_agents.cli._commands import whoami as whoami_cmd
from culture_agents.cli._commands.doctor import cmd_doctor
from culture_agents.cli._commands.explain import cmd_explain
from culture_agents.cli._commands.learn import cmd_learn
from culture_agents.cli._commands.overview import cmd_overview
from culture_agents.explain.catalog import ENTRIES

PROG = "agents"
DESCRIPTION = (
    "agents - the control plane for AgentCulture agents: dispatch, runs and lifecycle control."
)

#: (group, name, function, flags). The explain catalog entry for the path (if
#: any) becomes the tool's long doc, so the registry and ``explain`` agree.
_TOOLS: tuple[tuple[tuple[str, ...], str, Callable[..., Any], tuple[Flag, ...]], ...] = (
    ((), "whoami", whoami_cmd.whoami, ()),
    (("cli",), "overview", cli_cmd.cli_overview, ()),
    (("agents",), "list", agents_cmd.agents_list, ()),
    (("agents",), "status", agents_cmd.agents_status, ()),
    (("runs",), "submit", runs_cmd.runs_submit, runs_cmd.SUBMIT_FLAGS),
    (("runs",), "list", runs_cmd.runs_list, runs_cmd.LIST_FLAGS),
    (("runs",), "show", runs_cmd.runs_show, ()),
    (("runs",), "attach", runs_cmd.runs_attach, runs_cmd.ATTACH_FLAGS),
    (("runs",), "steer", runs_cmd.runs_steer, runs_cmd.CALLER_FLAGS),
    (("runs",), "cancel", runs_cmd.runs_cancel, runs_cmd.CANCEL_FLAGS),
    (("runs",), "logs", runs_cmd.runs_logs, runs_cmd.LOGS_FLAGS),
    (("runs",), "result", runs_cmd.runs_result, ()),
)

_META_HANDLERS = {
    "learn": cmd_learn,
    "explain": cmd_explain,
    "overview": cmd_overview,
    "doctor": cmd_doctor,
}


def build_app() -> App:
    app = App(name=PROG, version=__version__, description=DESCRIPTION)
    for group, name, func, flags in _TOOLS:
        app.tool(func, name=name, group=group, doc=ENTRIES.get(group + (name,)), flags=flags)
    seen: set[str] = set()
    for path, text in ENTRIES.items():
        if text not in seen:  # several keys alias one entry
            seen.add(text)
            app.add_doc(slug="-".join(path) or "agents", title=text.splitlines()[0][2:], text=text)
    return app


@lru_cache(maxsize=1)
def get_app() -> App:
    return build_app()


def derive_parser(app: App) -> argparse.ArgumentParser:
    """The agentfront CLI for *app*, with our meta-verbs and ``--version``."""
    parser = app.cli()
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    for name, handler in _META_HANDLERS.items():
        verb = subparsers.choices[name]
        if not any("--json" in a.option_strings for a in verb._actions):
            verb.add_argument("--json", action="store_true", help="emit JSON")
        verb.set_defaults(func=handler)
    return parser
