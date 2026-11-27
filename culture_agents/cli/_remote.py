"""Helpers of ``agents runs submit`` for a run on another fleet member (API 3.2).

``--alias`` names the repository as the executing member defines it. The base
commit defaults to the HEAD of the git checkout the CLI runs in (the design
record's question 9, at its recommended answer); ``--base`` names another and
``--no-base`` names none, so the run starts from the member's HEAD. The member
refuses a named commit its checkout lacks, and fetches nothing.
"""

from __future__ import annotations

import re
import shutil
import subprocess  # nosec B404 - one fixed git invocation, no shell
from typing import Any

from culture_agents.cli._errors import EXIT_USER_ERROR, CliError


def usage(message: str) -> CliError:
    return CliError(
        code=EXIT_USER_ERROR, message=message, remediation="see 'agents explain runs submit'"
    )


def checkout_head() -> str | None:
    """The HEAD commit of the git checkout the CLI runs in, or None outside one."""
    git = shutil.which("git")
    if git is None:
        return None
    try:
        done = subprocess.run(  # nosec B603 - fixed arguments, no shell, no user input
            [git, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = done.stdout.strip()
    return sha if done.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None


def remote_base(base: str | None, no_base: bool) -> str | None:
    if base is not None and no_base:
        raise usage("give --base or --no-base, not both")
    if no_base:
        return None
    return base if base is not None else checkout_head()


def check_submit(repo: str | None, alias: str | None, remote_only: dict[str, Any]) -> None:
    if (repo is None) == (alias is None):
        raise usage(
            "give --repo (a run on this core) or --alias (a run on the member --agent names)"
        )
    given = [flag for flag, value in remote_only.items() if value]
    if alias is None and given:
        raise usage(f"{given[0]} goes with --alias (a run on another member)")
