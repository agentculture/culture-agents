#!/usr/bin/env python3
"""Fail when a tracked file names a node other than the example node.

Fixtures, tests and documents in this repo use one example node,
``EXAMPLE_NODE``. No real host name of the fleet belongs in a tracked file,
and the simplest rule that keeps one out is that every place a node is named
names the example. This check reads each tracked text file line by line and
looks at three shapes:

* **run id** — a typed id ``<node>-<agent>.run.<ulid>`` (session ``.ses.`` and
  action ``.act.`` ids have the same shape and are reported under the same
  kind), wherever it appears, a ``runs/<id>`` branch name included;
* **agent id** — the mesh id ``<node>-<agent>`` given as an ``agent_id`` /
  ``agentId`` value, after ``--agent`` or ``--caller``, or in a
  ``/v1/agents/<id>`` path. A value with no hyphen has no node part and is
  not an agent id;
* **node field** — a quoted value assigned to or compared with ``node``
  (``"node": "x"``, ``node: "x"``, ``NODE = "x"``, ``.node == "x"``), or an
  unquoted ``node: x`` that ends a line or a string.

A value passes when its node is the example node, or one of two things that
name no node at all: a malformed variant of the example (the example followed
by a character a node name cannot hold, ``thor-1``, as the invalid contract
fixtures use), or length-boundary filler (one character repeated eight or
more times).

What it does not see: a node named only in prose, an operator or caller id
held in a plain ``id`` field (a harness id such as ``claude-code`` has the
same shape), and ids assembled at run time.

Not checked:

* ``CHANGELOG.md`` — release history, which is not rewritten;
* ``docs/specs/**``, ``docs/plans/**``, ``.devague/**`` — confirmed records
  that quote earlier names;
* ``spikes/**`` — throwaway probe evidence;
* ``.claude/skills/**`` — the vendored skill kit, cited verbatim;
* ``.eidetic/**`` — the memory store;
* ``**/node_modules/**``, ``**/dist/**`` and lockfiles — installed or
  generated;
* this script and its test, which must spell out failing examples.

Usage:
    check-example-node.py                 # check all tracked files (git ls-files)
    check-example-node.py path [path...]  # check specific files

Output contract (the repo's): a one-line result on stdout; each finding on
stderr as ``path:line: <kind> names node '<node>' (the example node is
'<example>')``. Exit 0 when clean; 1 on any finding or on bad input (an
unknown flag, a path outside the repo); 2 only when ``git ls-files`` cannot
run. Explicit paths that are not checked are named on stderr rather than
silently counted as passing.
"""

from __future__ import annotations

import argparse
import re
import subprocess  # nosec B404 - fixed git invocation only
import sys
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parent.parent

#: The one node name fixtures, tests and documents use. One place to change it.
EXAMPLE_NODE = "thor"

#: Path prefixes (repo-relative, POSIX) never checked — see the docstring.
EXCLUDED_PREFIXES = (
    ".claude/skills/",
    ".devague/",
    ".eidetic/",
    "docs/plans/",
    "docs/specs/",
    "spikes/",
)

#: Whole paths never checked.
EXCLUDED_FILES = frozenset(
    {
        "CHANGELOG.md",
        "scripts/check-example-node.py",
        "tests/test_check_example_node.py",
    }
)

#: File names never checked, wherever they are (lockfiles).
EXCLUDED_NAMES = frozenset({"uv.lock", "package-lock.json"})

#: Path segments that exclude a file wherever they appear (generated/installed).
EXCLUDED_SEGMENTS = frozenset({"node_modules", "dist"})

#: Shortest run of one repeated character accepted as length-boundary filler.
MIN_FILLER = 8

_NAME = r"[A-Za-z0-9][A-Za-z0-9_.-]*"

#: ``<node>-<agent>.run|ses|act.<ulid>``; group 1 is the node.
_TYPED_ID = re.compile(
    r"(?<![A-Za-z0-9_.-])([a-z0-9]+)-[a-z0-9_]+(?:-[a-z0-9_]+)*\.(?:run|ses|act)\.(?=[0-9A-Za-z])"
)

#: Places that hold a mesh id; group 1 is the whole value.
_AGENT_IDS = (
    re.compile(rf"""(?:agent_id|agentId)["']?\s*(?::|==?)\s*["']({_NAME})["']"""),
    re.compile(rf"""--(?:agent|caller)\b["']?(?:\s*[,=]\s*|\s+)["']?({_NAME})"""),
    re.compile(rf"/v1/agents/({_NAME})"),
)

#: Places that hold a node name; group 1 is the value.
_NODE_FIELDS = (
    re.compile(rf"""(?i)(?<![A-Za-z0-9_/#@-])node["']?\s*(?::|==?)\s*["']({_NAME})["']"""),
    re.compile(rf"""(?<![A-Za-z0-9_/#@-])node:[ \t]+({_NAME})(?=["'`]|\s*$)"""),
)


class Finding(NamedTuple):
    """One place a file names a node that is not the example node."""

    path: str
    line: int
    kind: str
    node: str


def is_checked(rel: str) -> bool:
    """Whether a repo-relative path is held to the rule."""
    if rel in EXCLUDED_FILES or rel.startswith(EXCLUDED_PREFIXES):
        return False
    *parents, name = rel.split("/")
    return name not in EXCLUDED_NAMES and not EXCLUDED_SEGMENTS & set(parents)


def names_no_other_node(node: str) -> bool:
    """Whether ``node`` is the example node, or names no node at all."""
    if node == EXAMPLE_NODE:
        return True
    if len(node) >= MIN_FILLER and len(set(node)) == 1:
        return True  # length-boundary filler
    rest = node.removeprefix(EXAMPLE_NODE)
    # a malformed variant of the example: no valid node name continues this way
    return rest != node and not re.match(r"[a-z0-9]", rest)


def _mesh_node(value: str) -> str | None:
    """The node part of a mesh id, or ``None`` when ``value`` has no node part."""
    node, hyphen, _agent = value.partition("-")
    return node if hyphen and node else None


def scan_line(line: str) -> list[tuple[str, str]]:
    """``(kind, node)`` for each foreign node the line names, left to right by kind."""
    found: list[tuple[str, str]] = []
    typed_spans = []
    for match in _TYPED_ID.finditer(line):
        typed_spans.append(match.span())
        if not names_no_other_node(match.group(1)):
            found.append(("run id", match.group(1)))
    for pattern in _AGENT_IDS:
        for match in pattern.finditer(line):
            start = match.start(1)
            if any(lo <= start < hi for lo, hi in typed_spans):
                continue  # a typed id in an agent position: already judged above
            node = _mesh_node(match.group(1))
            if node is not None and not names_no_other_node(node):
                found.append(("agent id", node))
    for pattern in _NODE_FIELDS:
        for match in pattern.finditer(line):
            if not names_no_other_node(match.group(1)):
                found.append(("node field", match.group(1)))
    return found


def find_violations(repo: Path, paths: list[str]) -> list[Finding]:
    """Every finding in the checked files among ``paths``, in input and line order."""
    findings: list[Finding] = []
    for rel in paths:
        if not is_checked(rel):
            continue
        path = repo / rel
        if not path.is_file():  # deleted in the worktree, or a symlink to a directory
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # not a text file
        for number, line in enumerate(text.splitlines(), start=1):
            findings.extend(Finding(rel, number, kind, node) for kind, node in scan_line(line))
    return findings


def tracked_files(repo: Path) -> list[str]:
    """Repo-relative paths of every tracked file, via ``git ls-files``."""
    proc = subprocess.run(  # nosec B603,B607 - fixed git invocation
        ["git", "ls-files", "-z"],
        cwd=repo,
        capture_output=True,
        check=True,
    )
    return [p for p in proc.stdout.decode("utf-8").split("\0") if p]


class UsageError(Exception):
    """Bad user input — reported on stderr and mapped to exit 1."""


class _Parser(argparse.ArgumentParser):
    """An ArgumentParser whose usage errors exit 1, not argparse's default 2."""

    def error(self, message: str) -> None:  # type: ignore[override]
        raise UsageError(message)


def _repo_relative(raw: str, repo: Path) -> str:
    try:
        return Path(raw).resolve().relative_to(repo).as_posix()
    except ValueError:
        raise UsageError(f"{raw} is outside the repo ({repo})") from None


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _main(argv: list[str] | None) -> int:
    parser = _Parser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("paths", nargs="*", help="Files to check (default: all tracked files).")
    parser.add_argument("--repo", default=str(REPO_ROOT), help="Repo root.")
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    if args.paths:
        paths = [_repo_relative(p, repo) for p in args.paths]
        for rel in paths:
            if not is_checked(rel):
                print(f"{rel}: not checked (a record, vendored or generated)", file=sys.stderr)
    else:
        try:
            paths = tracked_files(repo)
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"error: could not list tracked files: {exc}", file=sys.stderr)
            return 2

    checked = [p for p in paths if is_checked(p)]
    findings = find_violations(repo, checked)
    for f in findings:
        print(
            f"{f.path}:{f.line}: {f.kind} names node '{f.node}' "
            f"(the example node is '{EXAMPLE_NODE}')",
            file=sys.stderr,
        )

    if findings:
        print(f"example node: {len(findings)} finding(s) in {len(checked)} file(s) checked")
        return 1
    print(f"example node: clean ({len(checked)} file(s) checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
