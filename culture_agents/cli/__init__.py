"""Unified CLI entry point for ``agents`` (the culture-agents control plane).

The CLI is built on agentfront: :mod:`culture_agents.cli._app` declares every
verb once into an ``App``, and agentfront derives the parser, ``--json``, and
the nested noun groups (``agents agents ...``, ``agents runs ...``, ``agents
cli ...``) from that registry.

Error propagation contract
--------------------------
Every handler raises :class:`culture_agents.cli._errors.CliError` on failure;
the dispatcher routes it through :mod:`culture_agents.cli._output` (``error:`` /
``hint:`` on stderr, or a JSON object with ``--json``). Unknown exceptions are
wrapped so no Python traceback leaks. Argparse errors (unknown verb, missing
argument) take the same path and exit 1; whether they render as text or JSON
depends on whether ``--json`` appears in the raw argv.
"""

from __future__ import annotations

import sys

from agentfront.cli_surface import _CliParser, _dispatch, _propagate_raw_argv

from culture_agents.cli import _mode
from culture_agents.cli._app import derive_parser, get_app


def _argv_has_json(argv: list[str] | None) -> bool:
    tokens = argv if argv is not None else sys.argv[1:]
    return any(t == "--json" or t.startswith("--json=") for t in tokens)


def main(argv: list[str] | None = None) -> int:
    parser = derive_parser(get_app())
    _propagate_raw_argv(parser, argv)  # lets parse errors honour --json
    json_mode = _argv_has_json(argv)
    prior = _mode.JSON_MODE.set(json_mode)
    try:
        try:
            args = parser.parse_args(argv)
        except _CliParser._Exit as stop:  # --help, --version, or a structured parse error
            return stop.code
        if getattr(args, "command", None) is None:
            parser.print_help()
            return 0
        return _dispatch(args, json_mode=bool(getattr(args, "json", False)))
    finally:
        _mode.JSON_MODE.reset(prior)


if __name__ == "__main__":
    sys.exit(main())
