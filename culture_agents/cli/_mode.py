"""Whether the current invocation asked for ``--json``.

Most verbs return a value and let the dispatcher print it in the right mode.
A streaming verb (``runs attach``) prints as it goes, so it needs the mode
itself; ``main()`` sets it from raw argv before dispatch, the same peek the
parse-error path uses.
"""

from __future__ import annotations

from contextvars import ContextVar

JSON_MODE: ContextVar[bool] = ContextVar("culture_agents_json_mode", default=False)
