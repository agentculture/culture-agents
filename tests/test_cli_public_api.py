"""The CLI uses agentfront's public API only, and keeps ``run_cli``'s contract."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

from culture_agents.cli import _mode, main
from culture_agents.cli._app import get_app
from tests.cli_support import run

REPO = Path(__file__).resolve().parent.parent
PRIVATE = re.compile(
    r"agentfront\._|agentfront\.cli_surface|_CliParser|_propagate_raw_argv|\b_dispatch\b"
    r"|\._actions\b|\._subparsers\b|_SubParsersAction|subparsers\.choices"
)


def test_no_private_agentfront_or_argparse_symbol_is_used() -> None:
    hits = []
    for path in sorted((REPO / "culture_agents").rglob("*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if PRIVATE.search(line):
                hits.append(f"{path.relative_to(REPO)}:{number}: {line.strip()}")
    assert not hits, "\n".join(hits)


def test_the_pin_is_the_release_with_the_public_api() -> None:
    project = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert "agentfront>=0.22,<0.23" in project["dependencies"]


def test_meta_verbs_are_registered_through_the_public_hook() -> None:
    app = get_app()
    assert all(app.get_meta_verb(name) is not None for name in ("explain", "overview", "doctor"))
    assert app.learn_sections  # learn is agentfront's own, extended with our sections


def test_help_returns_zero_and_does_not_raise(capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "runs", "attach", "--help")
    assert r.rc == 0
    assert "usage: agents runs attach" in r.out


def test_a_parse_error_is_structured_in_both_modes(capsys: pytest.CaptureFixture[str]) -> None:
    text = run(capsys, "runs", "show")
    assert text.rc == 1
    assert text.out == ""
    assert text.err.startswith("error: ")
    assert "\nhint: " in text.err
    j = run(capsys, "runs", "show", "--json")
    assert j.rc == 1
    assert j.out == ""
    assert {"code", "message", "remediation"} <= set(j.err_json())


def test_an_unexpected_exception_is_wrapped_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from culture_agents.cli._commands import whoami

    def boom() -> dict:
        raise RuntimeError("kaput")

    monkeypatch.setattr(whoami, "report", boom)
    r = run(capsys, "whoami", "--json")
    assert r.rc == 1
    assert r.out == ""
    assert "kaput" in r.err_json()["message"]
    assert "Traceback" not in r.err


def test_json_mode_is_set_for_handlers_and_reset_afterwards(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from culture_agents.cli._commands import whoami

    seen: list[bool] = []

    def spy() -> dict:
        seen.append(_mode.JSON_MODE.get())
        return {"nick": "x", "version": "0", "backend": "b", "model": "m"}

    monkeypatch.setattr(whoami, "report", spy)
    assert main(["whoami", "--json"]) == 0
    assert main(["whoami"]) == 0
    capsys.readouterr()
    assert seen == [True, False]
    assert _mode.JSON_MODE.get() is False


def test_learn_is_the_registry_listing_plus_our_sections(
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = json.loads(run(capsys, "learn", "--json").out)
    titles = [section["title"] for section in payload["sections"]]
    assert titles == [title for title, _ in get_app().learn_sections]
    assert "Exit-code policy" in titles
    text = run(capsys, "learn").out
    for title in titles:
        assert f"## {title}" in text
    for verb in ("learn", "explain", "overview", "doctor"):
        assert f"agents {verb} - " in text


# --- a closed stdout ---------------------------------------------------------


class _ClosedPipe:
    """A stdout whose reader has gone away."""

    def write(self, _text: str) -> int:
        raise BrokenPipeError(32, "Broken pipe")

    def flush(self) -> None:
        raise BrokenPipeError(32, "Broken pipe")


@pytest.mark.parametrize("argv", [["whoami"], ["whoami", "--json"], ["learn"], ["--help"]])
def test_a_closed_stdout_ends_quietly_with_exit_0(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    import sys

    monkeypatch.setattr(sys, "stdout", _ClosedPipe())
    assert main(argv) == 0
    assert capsys.readouterr().err == ""


def test_output_that_cannot_be_written_is_an_environment_error_not_a_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import io
    import sys

    class FullDisk(io.StringIO):
        def flush(self) -> None:
            raise OSError(28, "No space left on device")

    monkeypatch.setattr(sys, "stdout", FullDisk())
    assert main(["whoami", "--json"]) == 2
    err = json.loads(capsys.readouterr().err)
    assert err["code"] == 2
    assert "No space left on device" in err["message"]
    assert err["remediation"]
