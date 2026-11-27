"""Explain entries of the ``branches`` noun group."""

from __future__ import annotations

from culture_agents.explain.catalog_control import CORE_NOTE

_BRANCHES = f"""\
# agents branches

Noun group for the `runs/<run_id>` branches a repository collects from finished
runs. `list` shows them with each run's state; `remove` deletes the ones that
are safe to delete.

## Verbs

- `agents branches list --repo <path>` — every runs branch, its run's state and
  the git evidence.
- `agents branches remove --repo <path> [--dry-run]` — delete what is safe.

The repository must be one the operator's allow-list names (`denied`
otherwise).

{CORE_NOTE}"""

_LIST = f"""\
# agents branches list --repo <path>

Lists every `runs/<run_id>` branch of the repository. For each: the branch, its
run's state as the core reads it now (or `-` with a note when the run is
unknown or cannot be read), and the evidence: `reachable from <ref>` when
`git merge-base --is-ancestor` shows the branch tip contained in another local
branch (not a runs branch) or a remote-tracking ref.

## Usage

    agents branches list --repo /path/to/repo
    agents branches list --repo /path/to/repo --json

{CORE_NOTE}"""

_REMOVE = f"""\
# agents branches remove --repo <path> [--dry-run]

Deletes a runs branch only when all of these hold: its run is finished (not
`queued`, `running` or `cancelling`, and not `unknown`), the run is readable
and belongs to this repository, and git shows its commits reachable from
another ref. The delete is `git branch -d`; the core never forces one, so a
branch git refuses to delete (for example one checked out in a worktree) is
skipped and the refusal reported. Every skipped branch is listed with its
reason. `--dry-run` reports what would be deleted and deletes nothing.

## Usage

    agents branches remove --repo /path/to/repo --dry-run
    agents branches remove --repo /path/to/repo --json

{CORE_NOTE}"""

BRANCH_ENTRIES: dict[tuple[str, ...], str] = {
    ("branches",): _BRANCHES,
    ("branches", "list"): _LIST,
    ("branches", "remove"): _REMOVE,
}
