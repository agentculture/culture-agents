"""Guards for the TypeScript core scaffold under ``core/`` (plan task t7).

Three promises are pinned here, each one a way a TS toolchain quietly rots:

* the 400-line cap applies to ``.ts``/``.mts`` files, not only Python;
* every npm dependency in ``core/package.json`` is an exact version;
* the secret scan reaches TypeScript sources and ``core/`` JSON.

``spikes/`` is throwaway probe code and is exempt from the line cap.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
LENGTH_SCRIPT = REPO_ROOT / "scripts" / "check-file-length.py"
SCAN_SCRIPT = REPO_ROOT / "scripts" / "scan-secrets.py"
PACKAGE_JSON = REPO_ROOT / "core" / "package.json"

DEP_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
EXACT_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cfl = _load("check_file_length_ts", LENGTH_SCRIPT)
scan = _load("scan_secrets_ts", SCAN_SCRIPT)


def _run_length(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(LENGTH_SCRIPT), *args], capture_output=True, text=True, check=False
    )


def _write_lines(path: Path, n: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("export const x = 1;\n" * n, encoding="utf-8")
    return path


# --- file length -----------------------------------------------------------


@pytest.mark.parametrize("name", ["a.ts", "a.mts", "core/src/a.ts"])
def test_ts_files_are_held_to_the_cap(name: str) -> None:
    assert cfl.is_checked(name)


def test_spikes_and_dependencies_are_exempt() -> None:
    assert not cfl.is_checked("spikes/d1-probe/probe.ts")
    assert not cfl.is_checked("core/node_modules/pkg/index.ts")
    assert not cfl.is_checked("core/dist/src/index.d.ts")


def test_a_401_line_ts_file_fails_and_a_400_line_one_passes(tmp_path: Path) -> None:
    ok = _write_lines(tmp_path / "core" / "src" / "ok.ts", 400)
    big = _write_lines(tmp_path / "core" / "src" / "big.ts", 401)
    assert _run_length("--repo", str(tmp_path), str(ok)).returncode == 0
    proc = _run_length("--repo", str(tmp_path), str(big))
    assert proc.returncode == 1
    assert "core/src/big.ts: 401 lines (max 400)" in proc.stderr


# --- exact pins ------------------------------------------------------------


def test_core_package_json_has_no_range_specifiers() -> None:
    data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    assert data["name"] == "@culture.dev/agents"
    assert data["private"] is False
    checked = 0
    for section in DEP_SECTIONS:
        for name, spec in data.get(section, {}).items():
            checked += 1
            assert EXACT_VERSION.match(spec), f"{section}.{name} = {spec!r} is not an exact pin"
    assert checked > 0, "expected at least the dev toolchain to be pinned"


def test_core_has_a_committed_lockfile() -> None:
    tracked = subprocess.run(
        ["git", "ls-files", "core/package-lock.json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert tracked == ["core/package-lock.json"]


# --- secret scan -----------------------------------------------------------

_FAKE = "Xk9Lm2Pq7Rt4Vw8Zb3Nc6Hd5Jf1Sg0A"


def test_scan_covers_ts_and_core_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scan, "REPO_ROOT", tmp_path)
    (tmp_path / "core" / "src").mkdir(parents=True)
    (tmp_path / "core" / "src" / "a.ts").write_text(
        f'const apiKey = "{_FAKE}";\n', encoding="utf-8"
    )
    (tmp_path / "core" / "src" / "b.mts").write_text(
        f'export const token: string = "{_FAKE}";\n', encoding="utf-8"
    )
    (tmp_path / "core" / "settings.json").write_text(
        json.dumps({"endpoint": "https://api.example.org/v1"}), encoding="utf-8"
    )
    findings = scan.scan_paths(["core/src/a.ts", "core/src/b.mts", "core/settings.json"])
    assert {f.path for f in findings} == {"core/src/a.ts", "core/src/b.mts", "core/settings.json"}


def test_scan_does_not_flag_the_real_lockfile() -> None:
    findings = scan.scan_paths(["core/package.json", "core/package-lock.json"])
    assert findings == []
