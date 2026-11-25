#!/usr/bin/env python3
"""Bump the version in pyproject.toml and CHANGELOG.md.

If the package's ``__init__.py`` contains a literal ``__version__ = "..."``
assignment, the script also rewrites that value. In repos that read
``__version__`` from package metadata (the steward-cli convention), the
``__init__.py`` step is a no-op.

Usage:
    bump.py major    # 0.1.0 -> 1.0.0
    bump.py minor    # 0.1.0 -> 0.2.0
    bump.py patch    # 0.1.0 -> 0.1.1
    bump.py show     # print current version

Changelog entries are passed via stdin as a JSON object:
    {
      "added": ["New CLI command", "Observer module"],
      "changed": ["Restructured namespace"],
      "fixed": ["WHO reply index bug"]
    }

If no stdin is provided, an empty stub is inserted.

Mirrors: a repo that ships the same version in other files (an npm package
beside the Python one, a version constant in source) lists them in
pyproject.toml, and the bump moves them together or not at all:

    [tool.version-bump]
    placeholder = "0.0.0"      # optional: a mirror still at this version is left alone

    [[tool.version-bump.mirror]]
    path = "package.json"      # kind "json": the top-level "version"
    kind = "json"

    [[tool.version-bump.mirror]]
    path = "package-lock.json" # kind "npm-lock": "version" and packages[""].version
    kind = "npm-lock"

    [[tool.version-bump.mirror]]
    path = "src/index.ts"      # kind "text": a line holding the version
    kind = "text"
    pattern = 'export const version = "{version}";'

Every mirror is checked before anything is written. A mirror must hold the
current pyproject version (it is bumped) or the placeholder (it is skipped and
reported); any other value stops the bump with nothing changed.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path


def find_pyproject() -> Path:
    """Walk up from cwd to find pyproject.toml."""
    current = Path.cwd()
    while current != current.parent:
        candidate = current / "pyproject.toml"
        if candidate.exists():
            return candidate
        current = current.parent
    print("ERROR: pyproject.toml not found", file=sys.stderr)
    sys.exit(1)


def read_version(path: Path) -> str:
    """Extract version string from pyproject.toml."""
    text = path.read_text()
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        print("ERROR: version field not found in pyproject.toml", file=sys.stderr)
        sys.exit(1)
    return match.group(1)


def bump(version: str, part: str) -> str:
    """Bump the specified part of a semver version."""
    parts = version.split(".")
    if len(parts) != 3:
        print(f"ERROR: version '{version}' is not semver (x.y.z)", file=sys.stderr)
        sys.exit(1)

    major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])

    if part == "major":
        return f"{major + 1}.0.0"
    elif part == "minor":
        return f"{major}.{minor + 1}.0"
    elif part == "patch":
        return f"{major}.{minor}.{patch + 1}"
    else:
        print(f"ERROR: unknown bump type '{part}' (use major, minor, or patch)", file=sys.stderr)
        sys.exit(1)


def write_version(path: Path, old: str, new: str) -> None:
    """Replace old version with new in pyproject.toml."""
    text = path.read_text()
    updated = text.replace(f'version = "{old}"', f'version = "{new}"', 1)
    path.write_text(updated)


MIRROR_KINDS = ("json", "npm-lock", "text")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def read_mirror_config(pyproject: Path) -> tuple[list[dict], str | None]:
    """The ``[tool.version-bump]`` mirrors and placeholder; ([], None) when there are none."""
    try:
        import tomllib
    except ImportError:  # Python < 3.11: mirrors need tomllib; a repo without mirrors is unaffected
        if "[tool.version-bump" in pyproject.read_text():
            fail("[tool.version-bump] needs Python 3.11 or newer (tomllib)")
        return [], None
    config = tomllib.loads(pyproject.read_text()).get("tool", {}).get("version-bump", {})
    mirrors = config.get("mirror", [])
    for mirror in mirrors:
        if not isinstance(mirror.get("path"), str) or mirror.get("kind") not in MIRROR_KINDS:
            fail(f"mirror {mirror!r} needs a path and a kind in {MIRROR_KINDS}")
        if mirror["kind"] == "text" and "{version}" not in str(mirror.get("pattern", "")):
            fail(f"text mirror {mirror['path']} needs a pattern containing {{version}}")
    return mirrors, config.get("placeholder")


def _mirror_versions(kind: str, text: str, pattern: str | None) -> list[str]:
    """Every version value the mirror holds (all must agree)."""
    if kind == "text":
        head, tail = (re.escape(part) for part in str(pattern).split("{version}", 1))
        return re.findall(f"{head}([0-9A-Za-z.+-]+){tail}", text)
    data = json.loads(text)
    found = [data.get("version")]
    if kind == "npm-lock":
        found.append(data.get("packages", {}).get("", {}).get("version"))
    return found


def plan_mirrors(root: Path, mirrors: list[dict], placeholder: str | None, old: str) -> list[dict]:
    """Check every mirror and return the ones to rewrite. Exits before anything is written."""
    todo = []
    for mirror in mirrors:
        path = root / mirror["path"]
        if not path.is_file():
            fail(f"mirror {mirror['path']} does not exist")
        found = _mirror_versions(mirror["kind"], path.read_text(), mirror.get("pattern"))
        if not found or any(v != found[0] or not isinstance(v, str) for v in found):
            fail(f"mirror {mirror['path']} holds no single version (found {found})")
        if found[0] == old:
            todo.append(mirror)
        elif placeholder is not None and found[0] == placeholder:
            print(f"Left {mirror['path']} at the placeholder {placeholder}")
        else:
            fail(
                f"mirror {mirror['path']} is at {found[0]}, not at {old}"
                + (f" or the placeholder {placeholder}" if placeholder else "")
                + "; align it first. Nothing was changed."
            )
    return todo


def write_mirror(root: Path, mirror: dict, old: str, new: str) -> None:
    path = root / mirror["path"]
    text = path.read_text()
    if mirror["kind"] == "text":
        pattern = str(mirror["pattern"])
        path.write_text(text.replace(pattern.replace("{version}", old), pattern.replace("{version}", new)))
    else:
        data = json.loads(text)
        data["version"] = new
        if mirror["kind"] == "npm-lock":
            data["packages"][""]["version"] = new
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"Updated {mirror['path']}")


def read_changelog_entries() -> dict:
    """Read changelog entries from stdin as JSON."""
    if sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            return {}
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        print("WARNING: could not parse changelog JSON from stdin, using empty stub", file=sys.stderr)
        return {}


def format_changelog_section(new: str, entries: dict) -> str:
    """Format a changelog section from entries dict.

    Output uses single blank lines between elements (markdownlint MD012
    compliant). Trailing blank line before the next existing entry is
    included.
    """
    today = date.today().isoformat()
    chunks = [f"## [{new}] - {today}\n"]

    for section in ("added", "changed", "fixed"):
        items = entries.get(section, [])
        if items:
            chunks.append(f"\n### {section.capitalize()}\n\n")
            chunks.extend(f"- {item}\n" for item in items)

    # If no entries at all, emit empty section stubs.
    if not any(entries.get(s) for s in ("added", "changed", "fixed")):
        chunks.append("\n### Added\n\n### Changed\n\n### Fixed\n")

    chunks.append("\n")  # blank line before the next existing entry
    return "".join(chunks)


def update_changelog(project_root: Path, new: str, entries: dict) -> None:
    """Insert a new changelog entry into CHANGELOG.md."""
    changelog = project_root / "CHANGELOG.md"
    if not changelog.exists():
        print("No CHANGELOG.md found — skipping")
        return

    text = changelog.read_text()
    new_entry = format_changelog_section(new, entries)

    marker = "## ["
    idx = text.find(marker)
    if idx > 0:
        changelog.write_text(text[:idx] + new_entry + text[idx:])
        print(f"Updated CHANGELOG.md with [{new}]")
    else:
        print("WARNING: could not find insertion point in CHANGELOG.md", file=sys.stderr)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)

    part = sys.argv[1].lower()
    path = find_pyproject()
    current = read_version(path)

    if part == "show":
        print(current)
        sys.exit(0)

    # Read changelog entries before bumping
    entries = read_changelog_entries()

    new = bump(current, part)
    mirrors, placeholder = read_mirror_config(path)
    todo = plan_mirrors(path.parent, mirrors, placeholder, current)  # exits before any write
    write_version(path, current, new)
    for mirror in todo:
        write_mirror(path.parent, mirror, current, new)

    # Also update __init__.py if it has __version__
    init_candidates = [
        path.parent / path.parent.name / "__init__.py",
    ]
    for init in init_candidates:
        if init.exists():
            init_text = init.read_text()
            if f'__version__ = "{current}"' in init_text:
                init.write_text(init_text.replace(
                    f'__version__ = "{current}"',
                    f'__version__ = "{new}"',
                ))
                print(f"Updated {init.relative_to(path.parent)}")

    # Update changelog
    update_changelog(path.parent, new, entries)

    print(f"{current} -> {new}")


if __name__ == "__main__":
    main()
