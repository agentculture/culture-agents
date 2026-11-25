"""``scripts/check-d0-citations.py`` parses and resolves citations (no network)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check-d0-citations.py"
SHA_A = "a" * 40
SHA_B = "b" * 40

DOC = f"""# Inventory

| Repo | Commit | Version |
| --- | --- | --- |
| agentirc | `{SHA_A}` | 9.14.1 |
| culture-rules | `{SHA_B}` | 1.0 |

Prose cites `agentirc:agentirc/cli.py:878-903` and `culture-rules:a/b.py:12`.
Not a citation: `other:x.py:3`, `agentirc:no-line.py`, `Authorization: Bearer`.
"""


def _load():
    spec = importlib.util.spec_from_file_location("check_d0_citations", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolves annotations via sys.modules
    spec.loader.exec_module(module)
    return module


def test_parse_shas_reads_table_rows_only() -> None:
    mod = _load()
    assert mod.parse_shas(DOC) == {"agentirc": SHA_A, "culture-rules": SHA_B}


def test_parse_citations_handles_ranges_hyphenated_repos_and_noise() -> None:
    mod = _load()
    cits = mod.parse_citations(DOC, {"agentirc", "culture-rules"})
    assert [c.text for c in cits] == [
        "agentirc:agentirc/cli.py:878-903",
        "culture-rules:a/b.py:12",
    ]
    assert (cits[0].start, cits[0].end) == (878, 903)
    assert (cits[1].start, cits[1].end) == (12, 12)
    assert all(c.doc_line == 8 for c in cits)


def test_parse_citations_with_no_repos_finds_nothing() -> None:
    assert _load().parse_citations(DOC, set()) == []


def test_check_all_flags_missing_short_and_unpinned() -> None:
    mod = _load()
    shas = {"agentirc": SHA_A}
    calls: list[tuple[str, str, str]] = []

    def fetch(repo: str, path: str, sha: str):
        calls.append((repo, path, sha))
        return None if path == "gone.py" else ["x"] * 10

    def cit(repo: str, path: str, start: int, end: int):
        return mod.Citation(repo, path, start, end, 1)

    results = mod.check_all(
        [
            cit("agentirc", "ok.py", 10, 10),
            cit("agentirc", "ok.py", 3, 4),
            cit("agentirc", "ok.py", 11, 11),
            cit("agentirc", "gone.py", 1, 1),
            cit("agentirc", "ok.py", 5, 4),
            cit("culture-rules", "ok.py", 1, 1),
        ],
        shas,
        fetch,
    )
    problems = [r.problem for r in results]
    assert problems[0] == ""
    assert problems[1] == ""
    assert "10 lines, cited up to 11" in problems[2]
    assert "not found" in problems[3]
    assert "bad line span" in problems[4]
    assert "no SHA recorded" in problems[5]
    # (agentirc, ok.py) is fetched once however often it is cited.
    assert calls.count(("agentirc", "ok.py", SHA_A)) == 1


def test_main_exit_codes(tmp_path: Path, capsys, monkeypatch) -> None:
    mod = _load()
    doc = tmp_path / "inventory.md"
    doc.write_text(DOC, encoding="utf-8")
    monkeypatch.setattr(mod, "gh_fetcher", lambda repo, path, sha: ["l"] * 2000)
    assert mod.main([str(doc)]) == 0
    assert "failed: 0" in capsys.readouterr().out
    monkeypatch.setattr(mod, "gh_fetcher", lambda repo, path, sha: ["l"] * 5)
    assert mod.main([str(doc)]) == 1
    assert mod.main([str(tmp_path / "missing.md")]) == 2
    empty = tmp_path / "empty.md"
    empty.write_text("no table\n", encoding="utf-8")
    assert mod.main([str(empty)]) == 2
