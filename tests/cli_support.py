"""Helpers for driving the ``agents`` CLI in-process."""

from __future__ import annotations

import json
from typing import Any, NamedTuple

import pytest

from culture_agents.cli import main
from tests import contract_support as cs


class Ran(NamedTuple):
    rc: int
    out: str
    err: str

    def json(self) -> Any:
        return json.loads(self.out)

    def err_json(self) -> Any:
        return json.loads(self.err)


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> Ran:
    rc = main(list(argv))
    captured = capsys.readouterr()
    return Ran(rc, captured.out, captured.err)


def assert_valid(target: str, payload: Any) -> None:
    """*payload* validates against ``file.json`` or ``file.json#/$defs/name``."""
    errors = [e.message for e in cs.validator_for(target).iter_errors(payload)]
    assert not errors, f"{target}: {errors}"
