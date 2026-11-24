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
    assert isinstance(doc["jobs"], dict) and doc["jobs"]
    triggers = _triggers(doc)
    assert "push" in triggers and "pull_request" in triggers


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
    assert "--provenance" in text and "--access public" in text
    assert job["permissions"]["id-token"] == "write"
    assert "NODE_AUTH_TOKEN" not in WORKFLOW.read_text(encoding="utf-8")


def test_every_action_is_pinned_to_a_full_sha() -> None:
    doc = _load()
    uses = [s["uses"] for j in doc["jobs"].values() for s in _steps(j) if "uses" in s]
    assert uses
    for ref in uses:
        assert "@" in ref and SHA.match(ref.split("@", 1)[1]), ref
