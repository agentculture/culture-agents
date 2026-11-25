"""Unified CLI entry point for ``agents`` (the culture-agents control plane).

The CLI is built on agentfront's public API: :mod:`culture_agents.cli._app`
declares every verb once into an ``App``, and ``App.run_cli`` derives the
parser, ``--json``, ``--version`` and the nested noun groups (``agents agents
...``, ``agents runs ...``, ``agents cli ...``) from that registry, parses the
command line and dispatches.

Error propagation contract
--------------------------
Every handler raises :class:`culture_agents.cli._errors.CliError` on failure;
``run_cli`` renders it (``error:`` / ``hint:`` on stderr, or a JSON object with
``--json``) and returns its code. Unknown exceptions are wrapped so no Python
traceback leaks. Argparse errors (unknown verb, missing argument) take the same
path and exit 1; they render as JSON when ``--json`` is on the command line.
``run_cli`` never raises ``SystemExit`` for ``--help``, ``--version`` or a parse
error.

A closed stdout
---------------
``agents runs attach <id> | head -1`` closes our stdout while we still write.
That is the reader's choice and not an error: :func:`main` ends quietly with
exit 0 (see :class:`_PipeGuard`). Any other failure to write the output (a full
disk behind a redirect) is an environment error: one ``error:`` line, exit 2.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from culture_agents.cli import _mode
from culture_agents.cli._app import get_app
from culture_agents.cli._errors import EXIT_ENV_ERROR, CliError
from culture_agents.cli._output import emit_error


class _PipeGuard:
    """Stands in for ``sys.stdout``: when its reader goes away, it asks for a quiet exit.

    The request is a plain ``SystemExit``, which ``run_cli`` lets through (it wraps
    every ``Exception`` a handler raises as an "unexpected" error, and this is not
    one). ``closed`` tells :func:`main` that the exit came from here.
    """

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self.closed = False

    def _reader_gone(self) -> SystemExit:
        self.closed = True
        return SystemExit(0)

    def write(self, text: str) -> int:
        try:
            return self._stream.write(text)
        except BrokenPipeError:
            raise self._reader_gone() from None

    def flush(self) -> None:
        try:
            self._stream.flush()
        except BrokenPipeError:
            raise self._reader_gone() from None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def _discard_stdout(stream: Any) -> None:
    """Point the stdout file descriptor at the null device.

    What is still buffered is then dropped quietly when the interpreter
    flushes at exit, instead of raising ``BrokenPipeError`` a second time.
    """
    try:
        null = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(null, stream.fileno())
        finally:
            os.close(null)
    except (OSError, ValueError, AttributeError):
        pass  # not a real file (a test double, an embedded interpreter): nothing to redirect


def main(argv: list[str] | None = None) -> int:
    tokens = list(sys.argv[1:] if argv is None else argv)
    # A streaming verb prints as it goes, so it needs the mode before dispatch.
    prior = _mode.JSON_MODE.set("--json" in tokens)
    stdout = sys.stdout
    guard = _PipeGuard(stdout)
    sys.stdout = guard
    try:
        code = get_app().run_cli(tokens)
        try:
            sys.stdout.flush()
        except OSError as exc:  # for example a full disk behind a redirected stdout
            _discard_stdout(stdout)
            failure = CliError(
                code=EXIT_ENV_ERROR,
                message=f"cannot write the output to stdout: {exc.strerror or exc}",
                remediation="check where stdout is redirected to (disk full?), then retry",
            )
            emit_error(failure, json_mode=_mode.JSON_MODE.get())
            return failure.code
        return code
    except SystemExit:
        if not guard.closed:
            raise
        _discard_stdout(stdout)
        return 0
    finally:
        sys.stdout = stdout
        _mode.JSON_MODE.reset(prior)


if __name__ == "__main__":
    sys.exit(main())
