"""``agents branches list|remove`` — the ``runs/<run_id>`` branches of a repository.

``list`` shows each branch with its run's state and the git evidence that its
commits are reachable from another ref. ``remove`` asks the core to delete the
branches of finished runs that git shows reachable (``git branch -d``, never a
forced delete) and reports every branch it skipped, with the reason. The CLI
decides nothing: the core owns the evidence and the refusals.
"""

from __future__ import annotations

import os
from typing import Any

from agentfront import Flag

from culture_agents.cli import _render
from culture_agents.cli._client import CoreClient
from culture_agents.cli._render import Rendered, _get, _items, _val

REPO_FLAG = Flag(
    names=("--repo",),
    dest="repo",
    required=True,
    help="repository path on the core's host (it must be on the allow-list)",
)
LIST_FLAGS = (REPO_FLAG,)
REMOVE_FLAGS = (
    REPO_FLAG,
    Flag(
        names=("--dry-run",),
        dest="dry_run",
        action="store_true",
        help="report what would be deleted and delete nothing",
    ),
)


def _repo(repo: str | None) -> str:
    return os.path.abspath(repo or "")


def _branch_line(branch: Any) -> str:
    state = _val(_get(branch, "state"))
    note = _get(branch, "state_note")
    merged = _get(branch, "merged_into")
    evidence = f"reachable from {_val(merged)}" if merged else "not reachable from another ref"
    tail = f"  ({_val(note)})" if note else ""
    return f"{_val(_get(branch, 'branch'))}  {state}  {evidence}{tail}"


def branches_list(repo: str | None = None) -> Rendered:
    """List the runs branches of a repository with their runs' states."""
    payload = CoreClient().get("/v1/branches", "branch_list", {"repo": _repo(repo)})
    rows = [_branch_line(b) for b in _items(_get(payload, "branches"))]
    return _render.Rendered(payload, "\n".join(rows) if rows else "no runs branches")


def _removed_line(branch: Any, dry_run: bool) -> str:
    verb = "would delete" if dry_run else "deleted"
    return f"{verb} {_val(_get(branch, 'branch'))} (reachable from {_val(_get(branch, 'merged_into'))})"


def _skipped_line(skipped: Any) -> str:
    return f"skipped {_val(_get(skipped, 'branch'))}: {_val(_get(skipped, 'reason'))}"


def branches_remove(repo: str | None = None, dry_run: bool = False) -> Rendered:
    """Delete finished runs branches that git shows reachable from another ref."""
    body: dict[str, Any] = {"repo": _repo(repo)}
    if dry_run:
        body["dry_run"] = True
    payload = CoreClient().post("/v1/branches/remove", "branch_remove", body)
    dry = bool(_get(payload, "dry_run"))
    lines = [_removed_line(b, dry) for b in _items(_get(payload, "removed"))]
    lines += [_skipped_line(s) for s in _items(_get(payload, "skipped"))]
    return Rendered(payload, "\n".join(lines) if lines else "no runs branches")
