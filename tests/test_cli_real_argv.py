"""Behaviour that only shows when the CLI reads the real command line (``main()`` with no argv)."""

from __future__ import annotations

import json
import sys

import pytest

from culture_agents.cli import main


def test_a_parse_error_honours_json_on_the_real_command_line(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["agents", "runs", "show", "--json"])
    assert main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err)["message"].startswith("the following arguments are required")


def test_runs_list_accepts_every_state_of_the_contract(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """``unknown`` is the state an operator looks for after a restart; no core here, so exit 2."""
    monkeypatch.setenv("CULTURE_AGENTS_SOCKET", "/nonexistent/core.sock")
    assert main(["runs", "list", "--state", "unknown", "--json"]) == 2
    assert json.loads(capsys.readouterr().err)["error_code"] == "unavailable"
