"""Static checks on .github/workflows/publish.yml (npm first, then PyPI)."""

from __future__ import annotations

import re
from pathlib import Path

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


def test_npm_stage_runs_on_same_repo_pull_requests_only() -> None:
    doc = _load()
    stage = _npm_stage_jobs(doc)
    assert len(stage) == 1, "expected exactly one job that stages on npm"
    (job,) = stage.values()
    cond = str(job.get("if", ""))
    assert "github.event_name == 'pull_request'" in cond
    # A fork has no OIDC or environment context, so the job must skip there.
    assert "github.event.pull_request.head.repo.full_name == github.repository" in cond
    assert "test" in _needs(job)


def test_npm_stage_uses_the_trusted_publisher() -> None:
    doc = _load()
    (job,) = _npm_stage_jobs(doc).values()
    # The trusted publisher on npm names this workflow and the `npm` environment.
    assert job["environment"] == "npm"
    assert job["permissions"]["id-token"] == "write"
    assert job["permissions"]["contents"] == "read"
    text = "\n".join(_run_text(s) for s in _steps(job))
    assert "npm install -g npm@11.21.1" in text, "staging needs npm 11.15.0 or later"
    assert "npm ci" in text


def test_npm_stage_never_stages_the_real_version() -> None:
    """A staged version blocks publishing that version, so main could not release it."""
    doc = _load()
    (job,) = _npm_stage_jobs(doc).values()
    steps = _steps(job)
    text = "\n".join(_run_text(s) for s in steps)
    assert '"${BASE}-dev.${RUN_NUMBER}.${RUN_ATTEMPT}"' in text
    env = {k: v for s in steps for k, v in s.get("env", {}).items()}
    assert env["RUN_NUMBER"] == "${{ github.run_number }}"
    # The attempt keeps a re-run from staging a version that is already staged.
    assert env["RUN_ATTEMPT"] == "${{ github.run_attempt }}"
    # The built package reports the dev version too (core/src/index.ts).
    assert "src/index.ts" in text
    order = [i for i, s in enumerate(steps) if "DEV_VERSION=" in _run_text(s)]
    build = [i for i, s in enumerate(steps) if _run_text(s).strip() == "npm run build"]
    publish = [i for i, s in enumerate(steps) if "npm stage publish" in _run_text(s)]
    assert order and build and publish
    assert order[0] < build[0] < publish[0], "set the dev version, then build, then stage"


def test_npm_stage_tags_dev_and_never_publishes() -> None:
    doc = _load()
    stage = _npm_stage_jobs(doc)
    (job,) = stage.values()
    text = "\n".join(_run_text(s) for s in _steps(job))
    line = next(ln for ln in text.splitlines() if "npm stage publish" in ln)
    # A pre-release version needs an explicit tag, and must not become `latest`.
    assert "--tag dev" in line
    assert "--provenance" in line
    assert "--access public" in line
    assert not set(stage) & set(_npm_publish_jobs(doc)), "the staging job must not publish"
    assert "npm stage approve" not in WORKFLOW.read_text(encoding="utf-8")


def test_every_action_is_pinned_to_a_full_sha() -> None:
    doc = _load()
    uses = [s["uses"] for j in doc["jobs"].values() for s in _steps(j) if "uses" in s]
    assert uses
    for ref in uses:
        assert "@" in ref, ref
        assert SHA.match(ref.split("@", 1)[1]), ref
