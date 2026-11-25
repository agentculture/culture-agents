"""What ``agents learn`` says beyond the registry.

``learn`` is agentfront's own meta-verb: the purpose, the docs and the command
listing come from the registry, so they cannot drift from the registered
verbs, and its ``--json`` output is agentfront's (``name``, ``version``,
``purpose``, ``docs``, ``tools``, ``sections``, ``exit_codes``,
``json_support``, ``explain``). This module adds the sections the registry
cannot know, through ``App.add_learn_section``.
"""

from __future__ import annotations

from agentfront import App

from culture_agents.cli import _surface

_RUNTIME = """\
Direct dispatch, persistent runs and lifecycle control (submit, attach, steer,
cancel) over harness adapters, independent of chat. This CLI is a client of the
core daemon, which owns all run state and talks over a local Unix socket
(CULTURE_AGENTS_SOCKET, else $XDG_RUNTIME_DIR/culture-agents/core.sock). With
the core not running, every `agents agents` and `agents runs` verb exits 2 with
a hint. Every answer of the core is validated against the control-API contract
before it is shown."""

_EXIT_CODES = """\
  0 success
  1 user-input error (bad flag, bad path, missing arg) or a request the core
    refuses (denied, unsupported, busy, conflict, invalid, not_found)
  2 environment / setup error (core not running, incompatible API version, an
    answer from the core that breaks the contract)
  3+ reserved"""

_OUTPUT = """\
Errors in JSON mode emit {"code", "message", "remediation"} to stderr, plus
"error_code" and its typed fields when the core refused the request.
`agents runs attach --json` prints one event JSON object per line. In text
mode, control characters in text that came from a run (task, harness output,
summaries, reasons, error messages) are shown escaped, for example \\x1b and
\\n; --json output is the exact data."""


def sections(app: App) -> list[tuple[str, str]]:
    """The ``(title, text)`` sections to add, in order."""
    meta = [f"  agents {' '.join(path)} - {summary}" for path, summary in _surface.META_VERBS]
    pointers = "\n".join(
        f"  agents explain {group}"
        for group in sorted({t.group[0] for t in app.list_tools() if t.group})
    )
    return [
        ("Runtime", _RUNTIME),
        ("Meta-verbs", "\n".join(meta)),
        ("Exit-code policy", _EXIT_CODES),
        ("Errors and streaming output", _OUTPUT),
        ("Noun groups", pointers),
    ]
