"""``scripts/check-example-node.py``: tracked files name only the example node.

The node names used as bad examples here are invented (``mars``, ``venus``);
no real host name belongs in this file or anywhere else in the repo.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check-example-node.py"
ULID = "01JDQ5V7M2K8X9Y0Z1A2B3C4D5"


def _load():
    """Import scripts/check-example-node.py by path (scripts/ is not a package)."""
    spec = importlib.util.spec_from_file_location("check_example_node", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cen = _load()


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


PASSING = f"""{{
  "id": "thor-culture-agents.run.{ULID}",
  "agent_id": "thor-culture-agents",
  "session_id": "thor-culture-agents.ses.{ULID}",
  "node": "thor",
  "branch": "runs/thor-culture-agents.run.{ULID}"
}}
"""

FAILING = f"""{{
  "id": "mars-culture-agents.run.{ULID}",
  "agent_id": "venus-reviewer",
  "node": "mars"
}}
"""


def test_the_example_node_is_thor() -> None:
    assert cen.EXAMPLE_NODE == "thor"


def test_the_real_repo_names_only_the_example_node() -> None:
    """The gate CI runs."""
    proc = _run()
    assert proc.returncode == 0, proc.stderr
    assert proc.stderr == ""
    assert "example node: clean" in proc.stdout


def test_a_passing_file_passes(tmp_path: Path) -> None:
    _write(tmp_path / "ok.json", PASSING)
    assert cen.find_violations(tmp_path, ["ok.json"]) == []
    proc = _run("--repo", str(tmp_path), str(tmp_path / "ok.json"))
    assert proc.returncode == 0, proc.stderr
    assert proc.stderr == ""


def test_a_failing_file_fails_with_each_finding_on_stderr(tmp_path: Path) -> None:
    _write(tmp_path / "bad.json", FAILING)
    found = cen.find_violations(tmp_path, ["bad.json"])
    assert [(f.path, f.line, f.kind, f.node) for f in found] == [
        ("bad.json", 2, "run id", "mars"),
        ("bad.json", 3, "agent id", "venus"),
        ("bad.json", 4, "node field", "mars"),
    ]
    proc = _run("--repo", str(tmp_path), str(tmp_path / "bad.json"))
    assert proc.returncode == 1
    assert "bad.json:2: run id names node 'mars'" in proc.stderr
    assert "bad.json:3: agent id names node 'venus'" in proc.stderr
    assert "bad.json:4: node field names node 'mars'" in proc.stderr
    assert "bad.json" not in proc.stdout
    assert "3 finding(s)" in proc.stdout


@pytest.mark.parametrize(
    ("line", "kind"),
    [
        (f'run = "mars-a.run.{ULID}"', "run id"),
        (f"agents runs show mars-culture-agents.run.{ULID} --json", "run id"),
        (f'"session_id": "mars-a.ses.{ULID}"', "run id"),
        (f'"id":"mars-a.act.{ULID}"', "run id"),
        (f'"branch": "runs/mars-a.run.{ULID}"', "run id"),
        ('"agent_id": "mars-reviewer"', "agent id"),
        ('body = submitBody({ agent_id: "mars-other" })', "agent id"),
        ("agents runs submit --agent mars-culture-agents --harness claude-code", "agent id"),
        ('"runs", "submit", "--agent", "mars-culture-agents",', "agent id"),
        ('"--caller", "mars-planner", "--caller-kind", "agent"', "agent id"),
        ('call(socket, "GET", "/v1/agents/mars-nobody")', "agent id"),
        ('"node": "mars"', "node field"),
        ('startDaemon({ service, node: "mars", env })', "node field"),
        ('NODE = "mars"', "node field"),
        ("assert CoreClient().node == 'mars'", "node field"),
        ('assert "node: mars" in r.out', "node field"),
        ('"node": "my-host.example"', "node field"),
    ],
)
def test_each_shape_of_a_foreign_node_is_caught(tmp_path: Path, line: str, kind: str) -> None:
    _write(tmp_path / "f.txt", line + "\n")
    found = cen.find_violations(tmp_path, ["f.txt"])
    assert [f.kind for f in found] == [kind], found
    # the same line naming the example node is clean
    _write(tmp_path / "g.txt", line.replace("mars", "thor").replace("my-host.example", "thor"))
    assert cen.find_violations(tmp_path, ["g.txt"]) == []


@pytest.mark.parametrize(
    "line",
    [
        # a malformed variant of the example node, as the invalid fixtures use
        '"node": "thor-1"',
        # length-boundary filler: one repeated character is no node's name
        f'"id": "{"n" * 32}-{"a" * 60}.run.{ULID}"',
        f'"agent_id": "{"n" * 33}-agent"',
        # not node names at all
        '"node": { "$ref": "common.json#/$defs/node" },',
        "node: string;",
        "node: opts.node,",
        "The node: the machine a core runs on.",
        "opencode run --agent build",
        '"harness": "claude-code"',
        "Mesh id, written `<node>-<agent>`.",
        'f"thor-culture-agents.{tag}.{ulid}"',
    ],
)
def test_lines_that_name_no_other_node_pass(tmp_path: Path, line: str) -> None:
    _write(tmp_path / "f.txt", line + "\n")
    assert cen.find_violations(tmp_path, ["f.txt"]) == []


def test_records_and_vendored_trees_are_not_checked() -> None:
    assert cen.is_checked("contract/fixtures/valid/run/root.running.json")
    assert cen.is_checked("core/test/daemon/api.test.ts")
    assert cen.is_checked("tests/test_cli_runs.py")
    assert cen.is_checked("README.md")
    assert cen.is_checked("culture.yaml")
    for rel in (
        "CHANGELOG.md",
        "spikes/d0/probe.ts",
        ".claude/skills/cicd/SKILL.md",
        ".devague/plans/x.json",
        ".eidetic/memory/default__public.jsonl",
        "docs/specs/2026-11-25-d2-fleet-and-recovery.md",
        "docs/plans/2026-11-26-d2-fleet-and-recovery.md",
        "core/node_modules/x/index.js",
        "core/dist/src/x.js",
        "uv.lock",
        "core/package-lock.json",
        "scripts/check-example-node.py",
        "tests/test_check_example_node.py",
    ):
        assert not cen.is_checked(rel), rel


def test_a_file_that_is_not_text_is_skipped(tmp_path: Path) -> None:
    (tmp_path / "blob.bin").write_bytes(b'\xff\xfe"node": "mars"\x00')
    assert cen.find_violations(tmp_path, ["blob.bin"]) == []


# --- the rename itself: the former example node name is gone ---

FORMER_NODE = "spark"

#: Checked files that still hold the former name, and why each is left alone.
#: None of them uses it as an example node in an id or a node field.
FORMER_NAME_REMAINS = {
    # the D1 acceptance record: names a chat server that was running during the run
    "docs/d0/d1-acceptance.md",
    # a captured `git status` of a sibling repo: the name is part of a file name there
    "docs/d0/sibling-baseline.txt",
    # exported from a .devague delivery record, which quotes the same chat server
    "docs/deliveries/2026-11-24-issue-2-cross-repo-reorganization.md",
}


def test_no_checked_file_uses_the_former_example_node_name() -> None:
    """Every fixture, test and document moved to the example node.

    A new file that needs the word for something that is not a node name
    belongs in ``FORMER_NAME_REMAINS`` with its reason.
    """
    remaining = set()
    for rel in cen.tracked_files(REPO_ROOT):
        path = REPO_ROOT / rel
        if not cen.is_checked(rel) or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if FORMER_NODE in text.lower():
            remaining.add(rel)
    assert remaining == FORMER_NAME_REMAINS


def test_fixtures_and_tests_use_the_example_node() -> None:
    """The rename landed in each layer: contract fixtures, core tests, Python tests, docs."""
    for rel in (
        "contract/fixtures/valid/run/root.running.json",
        "contract/fixtures/streams/valid/succeeded.jsonl",
        "contract/README.md",
        "core/test/daemon/api.test.ts",
        "tests/fake_core.py",
        "culture_agents/explain/catalog_control.py",
    ):
        assert f"{cen.EXAMPLE_NODE}-culture-agents" in (REPO_ROOT / rel).read_text(
            encoding="utf-8"
        ), rel


# --- the exit-code contract: 1 for user error, 2 only for the environment ---


def test_an_unknown_flag_is_a_user_error_exit_1() -> None:
    proc = _run("--no-such-flag")
    assert proc.returncode == 1, proc.stderr
    assert "error:" in proc.stderr


def test_a_path_outside_the_repo_is_a_clean_user_error(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    outside = _write(tmp_path / "elsewhere.json", PASSING)
    proc = _run("--repo", str(repo), str(outside))
    assert proc.returncode == 1, proc.stderr
    assert "is outside the repo" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_a_failed_git_ls_files_is_an_environment_error_exit_2(tmp_path: Path) -> None:
    proc = _run("--repo", str(tmp_path))
    assert proc.returncode == 2, proc.stderr
    assert "could not list tracked files" in proc.stderr


def test_an_explicit_unchecked_path_is_named_not_silently_passed(tmp_path: Path) -> None:
    _write(tmp_path / "CHANGELOG.md", '"node": "mars"\n')
    proc = _run("--repo", str(tmp_path), str(tmp_path / "CHANGELOG.md"))
    assert proc.returncode == 0
    assert "CHANGELOG.md: not checked" in proc.stderr


# --- the gate is actually wired into CI ---


def test_the_ci_lint_job_runs_the_gate() -> None:
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "tests.yml").read_text(encoding="utf-8")
    )
    runs = [step.get("run", "") for step in workflow["jobs"]["lint"]["steps"]]
    assert any("scripts/check-example-node.py" in run for run in runs), runs
