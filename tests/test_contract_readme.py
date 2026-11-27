"""contract/README.md states what the core builds now (submitter, retry_after_ms, branches)."""

from __future__ import annotations

from tests import contract_support as cs

README = (cs.CONTRACT / "README.md").read_text(encoding="utf-8")


def _row(prefix: str) -> str:
    return next(line for line in README.splitlines() if line.startswith(prefix))


def test_submitter_row_is_built() -> None:
    assert "shape only" not in _row("| `submitter`: who submitted")
    assert "(planned, t11)" not in README


def test_retry_after_row_and_reattach_are_built() -> None:
    assert "shape only" not in _row("| `unavailable` may carry `retry_after_ms`")
    assert "**(planned, t9)**" not in README
    assert "**(planned)** What changes in this order" not in README


def test_branches_routes_and_schema_are_listed() -> None:
    for needle in ("`branches.json`", "`branches.list`", "`branches.remove`"):
        assert needle in README, needle
    files = [line for line in README.splitlines() if line.startswith("| `branches.json`")]
    assert files


def test_conflict_idempotency_key_row_does_not_list_answer() -> None:
    row = _row("| `conflict` may carry `idempotency_key`")
    assert "`runs.answer`" not in row
