"""t32: run directories the core cannot read are named over the API, and listing them is read-only.

Mock stage: the real CLI against the real core, with the stub harness. One run finishes
normally; one has junk appended to its event log; one is stamped with a newer store version.
"""

from __future__ import annotations

import json
from pathlib import Path

from tests.acceptance.d1.support import Core
from tests.acceptance.d2.conftest import MakeCore

WARNING = "warning: 2 runs could not be read; list them with: agents runs unreadable"


def _snapshot(directory: Path) -> dict[str, tuple[int, int, bytes]]:
    """Every file under *directory*: size, mtime and ctime in ns are compared with the bytes."""
    seen = {}
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            st = path.stat()
            key = str(path.relative_to(directory))
            seen[key] = (st.st_mtime_ns, st.st_ctime_ns, path.read_bytes())
    return seen


def _three_runs(core: Core) -> tuple[str, str, str]:
    repo = core.add_repo()
    ids = []
    for n in range(3):
        run, _ = core.submit("stub", repo, f"files: f{n}.txt")
        core.wait_terminal(run["id"], 30)
        ids.append(run["id"])
    return ids[0], ids[1], ids[2]


def test_runs_list_warns_once_and_runs_unreadable_names_each_run_without_touching_it(
    make_core: MakeCore,
) -> None:
    core = make_core()
    good, corrupt, newer = _three_runs(core)
    core.kill9()
    corrupt_dir = core.state_dir / "runs" / corrupt
    newer_dir = core.state_dir / "runs" / newer
    with (corrupt_dir / "events.jsonl").open("a") as log:
        log.write("{not json}\n")  # a finished run's cached summary no longer matches its log
    (newer_dir / "store.json").write_text('{"schema":99}\n')
    core.start()
    before = (_snapshot(corrupt_dir), _snapshot(newer_dir))
    assert before[0], "the corrupt directory holds files to compare"
    assert before[1], "the newer directory holds files to compare"

    listed = core.cli("runs", "list")
    assert listed.rc == 0, listed.err
    lines = listed.out.splitlines()
    assert lines.count(WARNING) == 1, listed.out
    assert lines[-1] == WARNING, listed.out
    assert good in listed.out
    assert corrupt not in listed.out
    assert newer not in listed.out

    as_json = core.ok("runs", "list")
    assert as_json["unreadable_count"] == 2
    assert [r["id"] for r in as_json["runs"]] == [good]

    named = core.ok("runs", "unreadable")
    assert named["count"] == 2
    by_id = {r["run_id"]: r for r in named["runs"]}
    assert set(by_id) == {corrupt, newer}
    assert by_id[corrupt]["reason"] == "unreadable_log"
    assert by_id[newer]["reason"] == "newer_version"
    text = core.cli("runs", "unreadable")
    assert text.rc == 0, text.err
    assert f"{corrupt}  unreadable_log  " in text.out
    assert f"{newer}  newer_version  " in text.out

    after = (_snapshot(corrupt_dir), _snapshot(newer_dir))
    assert after == before, "listing changed nothing"
    assert json.loads((newer_dir / "store.json").read_text()) == {"schema": 99}


def test_with_no_unreadable_run_there_is_no_warning_and_the_count_is_zero(
    make_core: MakeCore,
) -> None:
    core = make_core()
    _three_runs(core)
    assert "could not be read" not in core.cli("runs", "list").out
    assert core.ok("runs", "list")["unreadable_count"] == 0
    assert core.cli("runs", "unreadable").out.strip() == "no unreadable runs"
