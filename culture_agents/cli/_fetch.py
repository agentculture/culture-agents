"""``agents runs result`` on a run on another fleet member: bring its branch home (API 3.3).

The run's commits live in the executing member's repository. This core reads
them from that member over the fleet transport as a git bundle and passes the
bundle on through the control socket; the CLI then fetches the run's branch
into the caller's checkout. No shell, account or SSH on the executing host is
used. The bundle must hold exactly one ref, ``refs/heads/runs/<run_id>``; it
carries only the commits after the run's base commit, so the checkout must hold
that base (the default base of a remote submit is this checkout's HEAD).

The checkout is ``--into <path>``, else the git checkout the CLI runs in. Outside
a checkout the result is shown and nothing is fetched. A repeat fetch of the
same branch is a no-op; a different commit already on that branch is refused by
git, never overwritten.
"""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - fixed git invocations, no shell
import tempfile
from pathlib import Path
from typing import Any

from culture_agents.cli._client import CoreClient
from culture_agents.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from culture_agents.cli._render import Rendered
from culture_agents.cli._text import visible

_SIGNATURES = (b"# v2 git bundle\n", b"# v3 git bundle\n")
_REMEDY = "see 'agents explain runs result'"


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    git = shutil.which("git")
    if git is None:
        raise CliError(code=EXIT_ENV_ERROR, message="git is not installed", remediation=_REMEDY)
    return subprocess.run(  # nosec B603 - fixed arguments, no shell; refs are checked run ids
        [git, *args], cwd=cwd, capture_output=True, text=True, timeout=120, check=False
    )


def checkout_root(into: str | None) -> Path | None:
    """The top of the checkout to fetch into, or None outside one (--into must name one)."""
    where = Path(into) if into is not None else Path.cwd()
    done = _git(where, "rev-parse", "--show-toplevel") if where.is_dir() else None
    if done is not None and done.returncode == 0:
        return Path(done.stdout.strip())
    if into is not None:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"--into {visible(into)} is not a git checkout",
            remediation="give the path of a checkout of the run's repository",
        )
    return None


def _bad_bundle(why: str) -> CliError:
    return CliError(code=EXIT_ENV_ERROR, message=f"the core sent {why}", remediation=_REMEDY)


def _fetch(bundle: bytes, branch: str, checkout: Path) -> str:
    """Fetch ``branch`` from *bundle* into *checkout*; returns its tip."""
    if not bundle.startswith(_SIGNATURES):
        raise _bad_bundle("something that is not a git bundle")
    ref = f"refs/heads/{branch}"
    with tempfile.TemporaryDirectory(prefix="agents-bundle-") as tmp:
        path = Path(tmp) / "run.bundle"
        path.write_bytes(bundle)
        listed = _git(checkout, "bundle", "list-heads", str(path))
        if listed.returncode != 0:
            raise _bad_bundle(f"a bundle git cannot read: {visible(listed.stderr.strip()[:300])}")
        heads = listed.stdout.split()
        if len(heads) != 2 or heads[1] != ref:
            raise _bad_bundle(f"a bundle that holds other refs than {ref}")
        done = _git(checkout, "fetch", "--quiet", "--no-tags", str(path), f"{ref}:{ref}")
    if done.returncode != 0:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=f"could not bring {branch} into {checkout}: {visible(done.stderr.strip())}",
            remediation=(
                "the bundle carries only the run's commits: the checkout must hold the run's "
                "base commit ('agents runs show <run_id>'), and an existing branch of that name "
                "must not point elsewhere"
            ),
        )
    return heads[0]


def with_branch(
    done: Rendered, client: CoreClient, route: str, branch: str, into: str | None
) -> Rendered:
    """The result, plus the run's branch fetched into the caller's checkout."""
    checkout = checkout_root(into)
    if checkout is None:
        note = "not fetched: not in a git checkout (give --into <checkout>)"
        return Rendered(dict(done, fetched=None), f"{done}\n{note}")
    tip = _fetch(client.get_bytes(route + "/bundle"), branch, checkout)
    fetched: dict[str, Any] = {"branch": branch, "into": str(checkout), "tip": tip}
    return Rendered(
        dict(done, fetched=fetched), f"{done}\nfetched: {branch} ({tip}) into {checkout}"
    )
