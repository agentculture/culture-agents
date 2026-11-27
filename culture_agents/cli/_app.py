"""The agentfront :class:`App`: the one registry the CLI is derived from.

Every verb is declared once here. agentfront builds the argparse tree, the
``--json`` flag, ``--version`` and the nested noun groups from it, and
``App.run_cli`` parses and dispatches. Only agentfront's public API is used:

* ``explain``, ``overview`` and ``doctor`` are agentfront's meta-verbs. Their
  generic output cannot describe this repo (identity doctor, the explain
  catalog), so ``App.meta_verb`` points them at our handlers.
* ``learn`` stays agentfront's own, because its listing is the registry. What
  the registry cannot know is added with ``App.add_learn_section``.
* Errors are :class:`CliError` (agentfront's ``AgentfrontError``), so
  ``run_cli`` renders them and no traceback leaks.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Callable

from agentfront import App, Flag

from culture_agents import __version__
from culture_agents.cli._commands import agents as agents_cmd
from culture_agents.cli._commands import branches as branches_cmd
from culture_agents.cli._commands import cli as cli_cmd
from culture_agents.cli._commands import runs as runs_cmd
from culture_agents.cli._commands import whoami as whoami_cmd
from culture_agents.cli._commands.doctor import cmd_doctor
from culture_agents.cli._commands.explain import cmd_explain
from culture_agents.cli._commands.learn import sections as learn_sections
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
    (("agents",), "aliases", agents_cmd.agents_aliases, agents_cmd.ALIASES_FLAGS),
    (("runs",), "submit", runs_cmd.runs_submit, runs_cmd.SUBMIT_FLAGS),
    (("runs",), "list", runs_cmd.runs_list, runs_cmd.LIST_FLAGS),
    (("runs",), "unreadable", runs_cmd.runs_unreadable, ()),
    (("runs",), "show", runs_cmd.runs_show, ()),
    (("runs",), "attach", runs_cmd.runs_attach, runs_cmd.ATTACH_FLAGS),
    (("runs",), "steer", runs_cmd.runs_steer, runs_cmd.CALLER_FLAGS),
    (("runs",), "cancel", runs_cmd.runs_cancel, runs_cmd.CANCEL_FLAGS),
    (("runs",), "answer", runs_cmd.runs_answer, runs_cmd.ANSWER_FLAGS),
    (("runs",), "logs", runs_cmd.runs_logs, runs_cmd.LOGS_FLAGS),
    (("runs",), "result", runs_cmd.runs_result, ()),
    (("branches",), "list", branches_cmd.branches_list, branches_cmd.LIST_FLAGS),
    (("branches",), "remove", branches_cmd.branches_remove, branches_cmd.REMOVE_FLAGS),
)

_META_HANDLERS = {
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
    for verb, handler in _META_HANDLERS.items():
        app.meta_verb(verb, handler)
    for title, text in learn_sections(app):
        app.add_learn_section(title, text)
    return app


@lru_cache(maxsize=1)
def get_app() -> App:
    return build_app()
