"""The version-bump skill moves mirrored version files together, or changes nothing."""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUMP = ROOT / ".claude" / "skills" / "version-bump" / "scripts" / "bump.py"
CONFIG = """
[tool.version-bump]
placeholder = "0.0.0"

[[tool.version-bump.mirror]]
path = "core/package.json"
kind = "json"

[[tool.version-bump.mirror]]
path = "core/package-lock.json"
kind = "npm-lock"

[[tool.version-bump.mirror]]
path = "core/src/index.ts"
kind = "text"
pattern = 'export const version = "{version}";'
"""


def _repo(tmp_path: Path, mirror_version: str, config: str = CONFIG) -> Path:
    (tmp_path / "core" / "src").mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text(f'[project]\nname = "x"\nversion = "1.2.3"\n{config}')
    (tmp_path / "CHANGELOG.md").write_text("# Changelog\n\n## [1.2.3] - 2026-01-01\n\n- first\n")
    package = {"name": "@x/y", "version": mirror_version, "dependencies": {"a": "1.0.0"}}
    (tmp_path / "core" / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    lock = {
        "name": "@x/y",
        "version": mirror_version,
        "packages": {"": {"version": mirror_version}, "node_modules/a": {"version": "1.0.0"}},
    }
    (tmp_path / "core" / "package-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    index = f'/** v */\nexport const version = "{mirror_version}";\n'
    (tmp_path / "core" / "src" / "index.ts").write_text(index)
    return tmp_path


def _bump(repo: Path, part: str = "minor") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUMP), part], cwd=repo, capture_output=True, text=True, input=""
    )


def _versions(repo: Path) -> list[str]:
    lock = json.loads((repo / "core" / "package-lock.json").read_text())
    return [
        tomllib.loads((repo / "pyproject.toml").read_text())["project"]["version"],
        json.loads((repo / "core" / "package.json").read_text())["version"],
        lock["version"],
        lock["packages"][""]["version"],
        (repo / "core" / "src" / "index.ts").read_text().split('"')[1],
    ]


def test_aligned_mirrors_move_with_pyproject(tmp_path: Path) -> None:
    repo = _repo(tmp_path, "1.2.3")
    done = _bump(repo)
    assert done.returncode == 0, done.stderr
    assert _versions(repo) == ["1.3.0"] * 5
    lock = json.loads((repo / "core" / "package-lock.json").read_text())
    assert lock["packages"]["node_modules/a"]["version"] == "1.0.0", "dependencies are untouched"
    assert "## [1.3.0]" in (repo / "CHANGELOG.md").read_text()


def test_mirrors_at_the_placeholder_are_left_alone_and_reported(tmp_path: Path) -> None:
    repo = _repo(tmp_path, "0.0.0")
    done = _bump(repo, "patch")
    assert done.returncode == 0, done.stderr
    assert _versions(repo) == ["1.2.4", "0.0.0", "0.0.0", "0.0.0", "0.0.0"]
    assert "Left core/package.json at the placeholder 0.0.0" in done.stdout


def test_a_mirror_at_another_version_stops_the_bump_with_nothing_changed(tmp_path: Path) -> None:
    repo = _repo(tmp_path, "1.2.3")
    index = repo / "core" / "src" / "index.ts"
    index.write_text(index.read_text().replace("1.2.3", "1.2.2"))
    before = _versions(repo)
    done = _bump(repo)
    assert done.returncode == 1
    assert "core/src/index.ts is at 1.2.2, not at 1.2.3" in done.stderr
    assert _versions(repo) == before
    assert "## [1.3.0]" not in (repo / "CHANGELOG.md").read_text()


def test_a_repo_without_mirrors_bumps_as_before(tmp_path: Path) -> None:
    repo = _repo(tmp_path, "9.9.9", config="")
    assert _bump(repo).returncode == 0
    assert _versions(repo)[0] == "1.3.0"
    assert _versions(repo)[1] == "9.9.9"


def test_this_repo_declares_the_core_package_as_mirrors() -> None:
    config = tomllib.loads((ROOT / "pyproject.toml").read_text())["tool"]["version-bump"]
    assert [m["path"] for m in config["mirror"]] == [
        "core/package.json",
        "core/package-lock.json",
        "core/src/index.ts",
    ]
    for mirror in config["mirror"]:
        assert (ROOT / mirror["path"]).is_file()
    assert config["placeholder"] == "0.0.0"
