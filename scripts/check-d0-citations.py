#!/usr/bin/env python3
"""Verify the ``path:line`` citations in ``docs/d0/inventory.md``.

The inventory pins one upstream commit per repo in a table near the top::

    | agentirc | `<40-hex sha>` | ... |

and cites code as an inline-code span ``repo:path:LINE`` or ``repo:path:A-B``
(``repo`` is a name from that table). For every citation this script checks
that the file exists at the recorded SHA and has at least as many lines as the
highest line cited. It does NOT check that the cited line says what the prose
claims; ``--show`` prints the first and last line of each span.

Sources of file content:

* default: ``gh api repos/agentculture/<repo>/contents/<path>?ref=<sha>``
* ``--clone-dir DIR``: ``git -C DIR/<repo> show <sha>:<path>`` (read-only; the
  clone must contain the SHA)

Exit codes: 0 all citations verified, 1 at least one failed or none found,
2 environment error (unreadable inventory, no SHA table).
"""

from __future__ import annotations

import argparse
import re
import subprocess  # nosec B404 - runs gh/git with fixed argv, no shell
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

OWNER = "agentculture"
DEFAULT_DOC = Path(__file__).resolve().parents[1] / "docs" / "d0" / "inventory.md"
SHA_ROW = re.compile(r"^\|\s*([A-Za-z][\w.-]*)\s*\|\s*`([0-9a-f]{40})`\s*\|")

# Returns the file's lines, or None when the file does not exist at the SHA.
Fetcher = Callable[[str, str, str], "list[str] | None"]


@dataclass(frozen=True)
class Citation:
    """One ``repo:path:start[-end]`` span found on a line of the document."""

    repo: str
    path: str
    start: int
    end: int
    doc_line: int

    @property
    def text(self) -> str:
        span = str(self.start) if self.start == self.end else f"{self.start}-{self.end}"
        return f"{self.repo}:{self.path}:{span}"


@dataclass(frozen=True)
class Result:
    """Outcome for one citation; ``problem`` is empty when it resolved."""

    citation: Citation
    problem: str
    lines: "list[str] | None" = None


def parse_shas(text: str) -> dict[str, str]:
    """Return ``{repo: sha}`` from table rows shaped ``| repo | `sha` | ...``."""
    shas: dict[str, str] = {}
    for line in text.splitlines():
        match = SHA_ROW.match(line)
        if match:
            shas[match.group(1)] = match.group(2)
    return shas


def parse_citations(text: str, repos: "list[str] | set[str]") -> list[Citation]:
    """Find every inline-code citation whose repo is one of ``repos``."""
    if not repos:
        return []
    names = "|".join(re.escape(r) for r in sorted(repos, key=len, reverse=True))
    pattern = re.compile(rf"`(?P<repo>{names}):(?P<path>[^\s:`]+):(?P<a>\d+)(?:-(?P<b>\d+))?`")
    found: list[Citation] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for match in pattern.finditer(line):
            start = int(match.group("a"))
            end = int(match.group("b")) if match.group("b") else start
            found.append(Citation(match.group("repo"), match.group("path"), start, end, number))
    return found


def check_citation(cit: Citation, shas: dict[str, str], fetch: Fetcher) -> Result:
    """Resolve one citation against the pinned SHA for its repo."""
    sha = shas.get(cit.repo)
    if sha is None:
        return Result(cit, f"no SHA recorded for repo {cit.repo}")
    if cit.start < 1 or cit.end < cit.start:
        return Result(cit, f"bad line span {cit.start}-{cit.end}")
    lines = fetch(cit.repo, cit.path, sha)
    if lines is None:
        return Result(cit, f"path not found at {sha[:7]}")
    if len(lines) < cit.end:
        return Result(cit, f"file has {len(lines)} lines, cited up to {cit.end}", lines)
    return Result(cit, "", lines)


def check_all(citations: list[Citation], shas: dict[str, str], fetch: Fetcher) -> list[Result]:
    """Check every citation, fetching each (repo, path) only once."""
    cache: dict[tuple[str, str, str], "list[str] | None"] = {}

    def cached(repo: str, path: str, sha: str) -> "list[str] | None":
        key = (repo, path, sha)
        if key not in cache:
            cache[key] = fetch(repo, path, sha)
        return cache[key]

    return [check_citation(c, shas, cached) for c in citations]


def _decode(raw: bytes) -> list[str]:
    return raw.decode("utf-8", errors="replace").splitlines()


def gh_fetcher(repo: str, path: str, sha: str) -> "list[str] | None":
    """Fetch a file's lines from the GitHub contents API at ``sha``."""
    argv = [
        "gh",
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        f"repos/{OWNER}/{repo}/contents/{path}?ref={sha}",
    ]
    proc = subprocess.run(argv, capture_output=True, check=False)  # nosec B603
    return _decode(proc.stdout) if proc.returncode == 0 else None


def make_git_fetcher(clone_dir: Path) -> Fetcher:
    """Build a fetcher that reads ``<clone_dir>/<repo>`` with ``git show``."""

    def fetch(repo: str, path: str, sha: str) -> "list[str] | None":
        argv = ["git", "-C", str(clone_dir / repo), "show", f"{sha}:{path}"]
        proc = subprocess.run(argv, capture_output=True, check=False)  # nosec B603 B607
        return _decode(proc.stdout) if proc.returncode == 0 else None

    return fetch


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("doc", nargs="?", type=Path, default=DEFAULT_DOC)
    parser.add_argument("--clone-dir", type=Path, help="read from DIR/<repo> clones, not gh")
    parser.add_argument("--show", action="store_true", help="print the first and last cited line")
    return parser


def _report(results: list[Result], shas: dict[str, str], show: bool) -> int:
    failed = [r for r in results if r.problem]
    for res in results:
        cit = res.citation
        if res.problem:
            print(f"FAIL  inventory.md:{cit.doc_line}  {cit.text}  ({res.problem})")
        elif show and res.lines:
            for number in sorted({cit.start, cit.end}):
                print(f"  {cit.text} #{number}: {res.lines[number - 1].strip()[:100]}")
    pins = ", ".join(f"{repo}@{sha[:7]}" for repo, sha in sorted(shas.items()))
    ok = len(results) - len(failed)
    print(f"citations: {len(results)}  verified: {ok}  failed: {len(failed)}")
    print(f"pinned: {pins}")
    return 1 if failed or not results else 0


def main(argv: "list[str] | None" = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        text = args.doc.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot read {args.doc}: {exc}", file=sys.stderr)
        return 2
    shas = parse_shas(text)
    if not shas:
        print("error: no `| repo | `sha` |` table rows found", file=sys.stderr)
        return 2
    fetch = make_git_fetcher(args.clone_dir) if args.clone_dir else gh_fetcher
    results = check_all(parse_citations(text, set(shas)), shas, fetch)
    return _report(results, shas, args.show)


if __name__ == "__main__":
    sys.exit(main())
