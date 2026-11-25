"""The two scripts the publish workflow uses when a version may already be on npm."""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import tarfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec
    assert spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


state = _load("npm_release_state")
matches = _load("npm_registry_matches")


def _answer(returncode: int, stdout: str):
    return lambda cmd: subprocess.CompletedProcess(cmd, returncode, stdout, "")


@pytest.mark.parametrize(
    ("returncode", "stdout", "expected"),
    [
        (0, '["0.12.0", "0.13.0"]', "present"),
        (0, '["0.12.0"]', "absent"),
        (0, '"0.13.0"', "present"),
        (1, json.dumps({"error": {"code": "E404", "summary": "not found"}}), "absent"),
    ],
)
def test_state_reports_absent_or_present(returncode, stdout, expected, capsys) -> None:
    args = ["@culture.dev/agents", "0.13.0"]
    assert state.main(args, run=_answer(returncode, stdout)) == 0
    assert capsys.readouterr().out.strip() == expected


@pytest.mark.parametrize(
    ("returncode", "stdout"),
    [
        (1, json.dumps({"error": {"code": "E500", "summary": "registry down"}})),
        (0, "not json"),
        (0, '{"unexpected": true}'),
        (2, json.dumps({"error": {"code": "E404"}})),
    ],
)
def test_state_fails_closed_on_anything_unclear(returncode, stdout, capsys) -> None:
    assert state.main(["@culture.dev/agents", "0.13.0"], run=_answer(returncode, stdout)) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "publish nothing" in captured.err


def test_state_refuses_an_option_as_a_package_or_version(capsys) -> None:
    called = []
    assert state.main(["--registry=http://x", "0.13.0"], run=called.append) == 1
    assert state.main(["@culture.dev/agents", "latest"], run=called.append) == 1
    assert called == []
    assert capsys.readouterr().out == ""


def _tarball(path: Path, files: dict[str, bytes]) -> Path:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return path


FILES = {"package/package.json": b'{"version":"0.13.0"}', "package/dist/a.js": b"export {};\n"}


def test_registry_copy_with_the_same_files_matches(tmp_path: Path, capsys) -> None:
    local = _tarball(tmp_path / "local.tgz", FILES)
    remote = _tarball(tmp_path / "remote.tgz", dict(reversed(FILES.items())))
    code = matches.main([str(local), "@culture.dev/agents@0.13.0"], fetcher=lambda *_: remote)
    assert code == 0
    assert capsys.readouterr().out.strip() == "match"


def test_registry_copy_that_differs_fails_and_names_each_file(tmp_path: Path, capsys) -> None:
    local = _tarball(tmp_path / "local.tgz", {**FILES, "package/dist/new.js": b"1"})
    changed = {"package/package.json": FILES["package/package.json"], "package/dist/a.js": b"x"}
    remote = _tarball(tmp_path / "remote.tgz", {**changed, "package/old.js": b"2"})
    code = matches.main([str(local), "@culture.dev/agents@0.13.0"], fetcher=lambda *_: remote)
    err = capsys.readouterr().err
    assert code == 1
    assert "only in this commit's tarball: package/dist/new.js" in err
    assert "only in the registry's tarball: package/old.js" in err
    assert "content differs: package/dist/a.js" in err


def test_registry_check_fails_when_npm_fails_or_the_spec_is_not_exact(tmp_path: Path) -> None:
    local = _tarball(tmp_path / "local.tgz", FILES)

    def broken(*_):
        raise RuntimeError("npm pack failed")

    assert matches.main([str(local), "@culture.dev/agents@0.13.0"], fetcher=broken) == 1
    assert matches.main([str(local), "@culture.dev/agents@latest"], fetcher=broken) == 1
    assert matches.main([str(local), "--registry=http://x"], fetcher=broken) == 1


def test_registry_check_refuses_a_local_path_that_is_not_a_tgz_file(tmp_path: Path, capsys) -> None:
    called = []
    spec = "@culture.dev/agents@0.13.0"
    other = _tarball(tmp_path / "local.tar.gz", FILES)
    (tmp_path / "dir.tgz").mkdir()
    for path in (other, tmp_path / "dir.tgz", tmp_path / "missing.tgz"):
        assert matches.main([str(path), spec], fetcher=called.append) == 1
        assert "is not a .tgz file" in capsys.readouterr().err
    assert called == []


def test_the_workflow_never_publishes_a_version_already_on_npm() -> None:
    doc = yaml.safe_load((ROOT / ".github" / "workflows" / "publish.yml").read_text())
    steps = doc["jobs"]["publish-npm"]["steps"]
    by_run = {s.get("name", ""): s for s in steps}
    publish = next(s for s in steps if "npm publish" in s.get("run", ""))
    assert publish["if"] == "steps.npm.outputs.state == 'absent'"
    check = by_run["already on npm; check the registry copy matches this commit"]
    assert check["if"] == "steps.npm.outputs.state == 'present'"
    assert "npm_registry_matches.py" in check["run"]
    order = [s.get("id") or s.get("name") for s in steps]
    assert order.index("npm") < order.index(publish["name"])
