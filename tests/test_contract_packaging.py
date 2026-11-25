"""The contract schemas ship inside the wheel, from the one copy in ``contract/``."""

from __future__ import annotations

import shutil
import subprocess
import tomllib
import zipfile
from pathlib import Path

import pytest

from culture_agents.cli import _contract
from tests import contract_support as cs

REPO = cs.REPO_ROOT
PREFIX = "culture_agents/contract/"


def _force_include() -> dict[str, str]:
    project = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))
    return project["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]


def test_the_wheel_is_told_to_carry_every_contract_json_file() -> None:
    expected = {f"contract/{p.name}": PREFIX + p.name for p in sorted(cs.CONTRACT.glob("*.json"))}
    assert _force_include() == expected


def test_there_is_no_second_copy_in_the_tree() -> None:
    assert not (REPO / "culture_agents" / "contract").exists()
    assert _contract.schema_dir() == cs.CONTRACT  # a checkout reads the one copy
    assert set(_contract.load_schemas()) == {s["$id"] for s in cs.load_schemas().values()}


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not on PATH")
def test_a_built_wheel_holds_the_schemas_byte_for_byte(tmp_path: Path) -> None:
    built = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path), str(REPO)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert built.returncode == 0, built.stderr
    (wheel,) = tmp_path.glob("culture_agents-*.whl")
    with zipfile.ZipFile(wheel) as archive:
        shipped = {n: archive.read(n) for n in archive.namelist() if n.startswith(PREFIX)}
    assert shipped == {PREFIX + p.name: p.read_bytes() for p in cs.CONTRACT.glob("*.json")}
