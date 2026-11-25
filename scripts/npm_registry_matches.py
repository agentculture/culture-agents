#!/usr/bin/env python3
"""Check that the npm registry's copy of a version holds the same files as a local tarball.

    python3 scripts/npm_registry_matches.py <local.tgz> @culture.dev/agents@0.13.0

Used by the publish workflow when a version is already on npm (a re-run, or the
one-time bootstrap publish): the job must never publish over it, and must not
call the release good unless the registry copy is what this commit builds.

Downloads the registry tarball with ``npm pack <spec>`` into a temporary
directory and compares the two archives file by file: the same paths, and the
same SHA-256 for each. Modification times and archive order are ignored.
Prints ``match`` and exits 0, or lists every difference on stderr and exits 1.
Any npm failure also exits 1. Stdlib only.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

#: What reaches the npm command line: a package name (scope optional) at an exact version.
#: re.ASCII keeps \d to the digits 0-9.
NPM_SPEC = re.compile(
    r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", re.ASCII
)


def digests(tarball: Path) -> dict[str, str]:
    """path -> SHA-256 for every regular file in a package tarball."""
    found: dict[str, str] = {}
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            handle = archive.extractfile(member)
            if handle is None:
                continue
            found[member.name] = hashlib.sha256(handle.read()).hexdigest()
    return found


def differences(local: dict[str, str], registry: dict[str, str]) -> list[str]:
    """One line per file that is missing on either side or differs."""
    lines = [f"only in this commit's tarball: {p}" for p in sorted(set(local) - set(registry))]
    lines += [f"only in the registry's tarball: {p}" for p in sorted(set(registry) - set(local))]
    lines += [
        f"content differs: {p}"
        for p in sorted(set(local) & set(registry))
        if local[p] != registry[p]
    ]
    return lines


def fetch(spec: str, out_dir: Path) -> Path:
    """Download the registry tarball for *spec* into *out_dir*; raise RuntimeError on failure."""
    cmd = ["npm", "pack", spec, "--ignore-scripts", "--pack-destination", str(out_dir)]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"npm pack {spec} failed: {result.stderr.strip()[:500]}")
    tarballs = list(out_dir.glob("*.tgz"))
    if len(tarballs) != 1:
        raise RuntimeError(f"npm pack {spec} left {len(tarballs)} tarballs, expected exactly one")
    return tarballs[0]


def main(argv: list[str] | None = None, fetcher=fetch) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        raise SystemExit("usage: npm_registry_matches.py <local.tgz> <package>@<version>")
    local, spec = Path(args[0]).resolve(), args[1]
    if local.suffix != ".tgz" or not local.is_file():
        print(f"npm_registry_matches: {args[0]!r} is not a .tgz file", file=sys.stderr)
        return 1
    if not NPM_SPEC.fullmatch(spec):
        print(
            f"npm_registry_matches: {spec!r} is not a package at an exact version", file=sys.stderr
        )
        return 1
    try:
        with tempfile.TemporaryDirectory() as tmp:
            lines = differences(digests(local), digests(fetcher(spec, Path(tmp))))
    except (RuntimeError, OSError, tarfile.TarError, subprocess.SubprocessError) as exc:
        print(f"npm_registry_matches: cannot compare with {spec}: {exc}", file=sys.stderr)
        return 1
    if lines:
        print(
            f"npm_registry_matches: {spec} on npm is not what this commit builds:", file=sys.stderr
        )
        for line in lines:
            print(f"  {line}", file=sys.stderr)
        return 1
    print("match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
