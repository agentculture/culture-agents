"""Static checks on .github/workflows/publish.yml (npm first, then PyPI)."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "publish.yml"
SHA = re.compile(r"^[0-9a-f]{40}$")


def _load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _triggers(doc: dict) -> dict:
    # PyYAML (YAML 1.1) parses the bare key `on` as boolean True.
    return doc.get("on", doc.get(True))


def _steps(job: dict) -> list[dict]:
    return job.get("steps", [])


def _run_text(step: dict) -> str:
    return step.get("run", "")


def _needs(job: dict) -> list[str]:
    needs = job.get("needs", [])
    return [needs] if isinstance(needs, str) else list(needs)


def _npm_publish_jobs(doc: dict) -> dict:
    return {
        name: job
        for name, job in doc["jobs"].items()
        if any(
            re.search(r"^\s*npm publish\s+\S+(?!.*--dry-run)", _run_text(s), re.M)
            for s in _steps(job)
        )
    }


def test_workflow_parses_with_expected_triggers() -> None:
    doc = _load()
    assert isinstance(doc["jobs"], dict)
    assert doc["jobs"]
    triggers = _triggers(doc)
    assert "push" in triggers
    assert "pull_request" in triggers


def test_npm_dry_run_step_runs_on_pull_requests() -> None:
    doc = _load()
    dry = [
        (name, job)
        for name, job in doc["jobs"].items()
        if any("npm publish" in _run_text(s) and "--dry-run" in _run_text(s) for s in _steps(job))
    ]
    assert dry, "no npm publish --dry-run step"
    for name, job in dry:
        cond = str(job.get("if", ""))
        assert "'push'" not in cond or "!=" in cond, f"{name} is push-only"
        assert "id-token" not in job.get("permissions", {}), f"{name} needs no OIDC"
        assert any("npm ci" in _run_text(s) for s in _steps(job))


def test_pypi_publish_needs_npm_publish() -> None:
    doc = _load()
    npm_jobs = _npm_publish_jobs(doc)
    assert len(npm_jobs) == 1
    pypi = [
        (n, j)
        for n, j in doc["jobs"].items()
        if any(
            "uv publish" in _run_text(s) and "test.pypi.org" not in _run_text(s) for s in _steps(j)
        )
    ]
    assert len(pypi) == 1
    assert set(npm_jobs) <= set(_needs(pypi[0][1]))


def test_npm_publish_uses_provenance_and_oidc() -> None:
    doc = _load()
    (job,) = _npm_publish_jobs(doc).values()
    text = "\n".join(_run_text(s) for s in _steps(job))
    assert "--provenance" in text
    assert "--access public" in text
    assert job["permissions"]["id-token"] == "write"
    assert "NODE_AUTH_TOKEN" not in WORKFLOW.read_text(encoding="utf-8")


def _npm_stage_jobs(doc: dict) -> dict:
    return {
        name: job
        for name, job in doc["jobs"].items()
        if any("npm stage publish" in _run_text(s) for s in _steps(job))
    }


STAGE_IF = (
    "github.event_name == 'pull_request'"
    " && github.event.pull_request.head.repo.full_name == github.repository"
)
DEV_VERSION_LINE = 'DEV_VERSION="${BASE}-dev.${RUN_NUMBER}.${RUN_ATTEMPT}"'
STAGE_COMMAND = 'npm stage publish "$TARBALL" --tag dev --provenance --access public'


def _code_lines(step: dict) -> list[str]:
    """The step's shell lines without blank lines and comment-only lines."""
    lines = [ln.strip() for ln in _run_text(step).splitlines()]
    return [ln for ln in lines if ln and not ln.startswith("#")]


def _stage_job(doc: dict) -> dict:
    stage = _npm_stage_jobs(doc)
    assert len(stage) == 1, "expected exactly one job that stages on npm"
    (job,) = stage.values()
    return job


def _version_step(job: dict) -> dict:
    (step,) = [s for s in _steps(job) if DEV_VERSION_LINE in _code_lines(s)]
    return step


def test_npm_stage_runs_on_same_repo_pull_requests_only() -> None:
    job = _stage_job(_load())
    # The whole condition, not a substring: an added `|| ...` would let the job
    # run on a push or on a fork, where it must not.
    assert " ".join(str(job.get("if", "")).split()) == STAGE_IF
    assert "test" in _needs(job)


def test_npm_publish_runs_on_push_only() -> None:
    (job,) = _npm_publish_jobs(_load()).values()
    cond = " ".join(str(job.get("if", "")).split())
    assert cond == "github.event_name == 'push' && needs.version-gate.outputs.npm == 'publish'"


def test_npm_stage_uses_the_trusted_publisher() -> None:
    job = _stage_job(_load())
    # The trusted publisher on npm names this workflow and the `npm` environment.
    assert job["environment"] == "npm"
    assert job["permissions"] == {"contents": "read", "id-token": "write"}
    lines = [ln for s in _steps(job) for ln in _code_lines(s)]
    # Staging needs npm 11.15.0 or later; an exact pin, never a floating tag.
    assert "npm install -g npm@11.21.1 --ignore-scripts" in lines
    assert "npm ci --ignore-scripts" in lines


def test_npm_stage_never_stages_the_real_version() -> None:
    """A staged version blocks publishing that version, so main could not release it."""
    job = _stage_job(_load())
    steps = _steps(job)
    step = _version_step(job)
    lines = _code_lines(step)
    assert lines[0] == "set -euo pipefail", "a failed command must stop the step"
    # The run number and attempt reach this step, and no other assignment follows.
    assert step["env"] == {
        "RUN_NUMBER": "${{ github.run_number }}",
        "RUN_ATTEMPT": "${{ github.run_attempt }}",
    }
    assert [ln for ln in lines if ln.startswith("DEV_VERSION=")] == [DEV_VERSION_LINE]
    assert 'npm version "$DEV_VERSION" --no-git-tag-version --ignore-scripts' in lines
    # The guard that fails the step when the sed did not change src/index.ts.
    assert 'grep -qF "\\"${DEV_VERSION}\\"" src/index.ts' in lines
    version = steps.index(step)
    build = [i for i, s in enumerate(steps) if _code_lines(s) == ["npm run build"]]
    publish = [i for i, s in enumerate(steps) if STAGE_COMMAND in _code_lines(s)]
    assert build and publish
    assert version < build[0] < publish[0], "set the dev version, then build, then stage"


def _run_version_step(tmp_path: Path, index_ts: str) -> subprocess.CompletedProcess:
    """Run the workflow's own 'Set dev version' script on a copy of core's version files."""
    core = WORKFLOW.parent.parent.parent / "core"
    work = tmp_path / "core"
    (work / "src").mkdir(parents=True)
    for name in ("package.json", "package-lock.json"):
        shutil.copy(core / name, work / name)
    (work / "src" / "index.ts").write_text(index_ts, encoding="utf-8")
    env = dict(os.environ, RUN_NUMBER="123", RUN_ATTEMPT="2", GITHUB_ENV=str(tmp_path / "env"))
    script = _run_text(_version_step(_stage_job(_load())))
    return subprocess.run(  # noqa: S603 - the script is this repository's own workflow step
        ["bash", "-c", script], cwd=work, env=env, capture_output=True, text=True, check=False
    )


@pytest.mark.skipif(shutil.which("npm") is None, reason="npm is not installed")
def test_version_step_sets_the_dev_version_everywhere(tmp_path: Path) -> None:
    core = WORKFLOW.parent.parent.parent / "core"
    base = json.loads((core / "package.json").read_text(encoding="utf-8"))["version"]
    done = _run_version_step(tmp_path, (core / "src" / "index.ts").read_text(encoding="utf-8"))
    assert done.returncode == 0, done.stderr
    dev = f"{base}-dev.123.2"
    work = tmp_path / "core"
    assert json.loads((work / "package.json").read_text(encoding="utf-8"))["version"] == dev
    assert f'export const version = "{dev}";' in (work / "src" / "index.ts").read_text()
    assert f'"{base}"' not in (work / "src" / "index.ts").read_text()
    assert (tmp_path / "env").read_text(encoding="utf-8") == f"DEV_VERSION={dev}\n"


@pytest.mark.skipif(shutil.which("npm") is None, reason="npm is not installed")
def test_version_step_fails_when_index_ts_is_not_rewritten(tmp_path: Path) -> None:
    """If the version line in src/index.ts changes shape, the step must fail, not ship."""
    done = _run_version_step(tmp_path, 'export const VERSION = "0.0.1";\n')
    assert done.returncode != 0
    assert not (tmp_path / "env").exists(), "DEV_VERSION must not be exported after a failure"


def test_npm_stage_tags_dev_and_never_publishes() -> None:
    doc = _load()
    stage = _npm_stage_jobs(doc)
    job = _stage_job(doc)
    (step,) = [s for s in _steps(job) if any(ln.startswith("npm stage") for ln in _code_lines(s))]
    # The whole command: a pre-release needs an explicit tag and must not become
    # `latest`, and the tarball staged is the one packed in this step.
    assert _code_lines(step) == [
        "set -euo pipefail",
        'TARBALL="$(npm pack --silent)"',
        STAGE_COMMAND,
    ]
    assert not set(stage) & set(_npm_publish_jobs(doc)), "the staging job must not publish"
    every_line = [ln for j in doc["jobs"].values() for s in _steps(j) for ln in _code_lines(s)]
    # No other `npm stage` command runs anywhere: CI never approves or rejects.
    assert [ln for ln in every_line if ln.startswith("npm stage")] == [STAGE_COMMAND]


def test_every_action_is_pinned_to_a_full_sha() -> None:
    doc = _load()
    uses = [s["uses"] for j in doc["jobs"].values() for s in _steps(j) if "uses" in s]
    assert uses
    for ref in uses:
        assert "@" in ref, ref
        assert SHA.match(ref.split("@", 1)[1]), ref
