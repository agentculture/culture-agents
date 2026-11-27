"""CliError and exit-code policy (stable-contract).

Every failure inside culture-agents raises :class:`CliError`. ``main()``
catches it, formats via :mod:`culture_agents.cli._output`, and exits with
:attr:`CliError.code`. This guarantees:

* no Python traceback leaks to stderr (the agent-first error contract);
* every error has a structured shape ``{code, message, remediation}``;
* the exit-code policy is centralised in one place.

``CliError`` *is* agentfront's ``AgentfrontError`` (one class, so the agentfront
dispatcher and our handlers agree on what a structured failure is).
:class:`CoreError` extends it with the typed error the core returned.
"""

from __future__ import annotations

from typing import Any

from agentfront.errors import (
    EXIT_ENV_ERROR,
    EXIT_SUCCESS,
    EXIT_USER_ERROR,
    AgentfrontError,
)

from culture_agents.cli._text import visible

# Exit-code policy. Documented in ``agents learn`` output.
# 0      = success
# 1      = user-input error (bad flag, missing required arg, unknown path)
# 2      = environment / setup error (core not running, incompatible core)
# 3+     = reserved for future categorisation
CliError = AgentfrontError

__all__ = ["EXIT_ENV_ERROR", "EXIT_SUCCESS", "EXIT_USER_ERROR", "CliError", "CoreError"]


class CoreError(CliError):
    """A failure reported by (or about reaching) the core.

    ``error_code`` is the contract's typed code (``unsupported``,
    ``limit_reached``, ``unavailable`` ...); ``detail`` carries the extra
    typed fields of the error body (``capability``, ``limit``, ``signal``,
    ``client_api_version`` ...).
    Both are added to the JSON error output next to the standard
    ``{code, message, remediation}`` triple.

    The message may quote text that came from a run, so ``message`` (what text
    mode prints after ``error:``) has its control characters made visible,
    while the JSON output carries ``raw_message``, the exact text.
    """

    def __init__(
        self,
        *,
        code: int,
        message: str,
        remediation: str = "",
        error_code: str = "internal",
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code=code, message=visible(message), remediation=remediation)
        self.raw_message = message
        self.error_code = error_code
        self.detail = dict(detail or {})

    def to_dict(self) -> dict[str, object]:
        data = super().to_dict()
        data["message"] = self.raw_message
        data["error_code"] = self.error_code
        data.update(self.detail)
        return data
