"""The CLI surface: prog name, no template wording, registry/explain/learn agreement."""

from __future__ import annotations

import argparse
import re

import pytest

from culture_agents.cli._app import get_app
from culture_agents.explain import known_paths, resolve
from tests.cli_support import run

NEW_VERBS = [
    ("agents", "list"),
    ("agents", "status"),
    ("runs", "submit"),
    ("runs", "list"),
    ("runs", "show"),
    ("runs", "attach"),
    ("runs", "steer"),
    ("runs", "cancel"),
    ("runs", "logs"),
    ("runs", "result"),
]
TEMPLATE_WORDING = re.compile(r"template|clonable|rename the package|clone it", re.IGNORECASE)


def _tool_paths() -> set[tuple[str, ...]]:
    return {t.group + (t.name,) for t in get_app().list_tools()}


def test_parser_prog_is_agents() -> None:
    parser = get_app().cli()
    assert parser.prog == "agents"
    assert "culture-agents" not in (parser.description or "")


def test_every_new_verb_is_registered() -> None:
    assert set(NEW_VERBS) <= _tool_paths()
    assert ("whoami",) in _tool_paths() and ("cli", "overview") in _tool_paths()


@pytest.mark.parametrize("path", sorted(_tool_paths()))
def test_every_verb_has_an_explain_entry(path: tuple[str, ...]) -> None:
    assert path in known_paths()
    entry = resolve(path)
    assert entry.startswith("# ")


def _leaf_parsers(parser: argparse.ArgumentParser):
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for sub in action.choices.values():
                yield from _leaf_parsers(sub)
            return
    yield parser


def test_every_leaf_verb_supports_json() -> None:
    leaves = list(_leaf_parsers(get_app().cli()))
    assert len(leaves) >= 6 + len(NEW_VERBS)
    for leaf in leaves:
        assert any("--json" in a.option_strings for a in leaf._actions), leaf.prog


def test_no_template_wording_in_learn_or_explain(capsys: pytest.CaptureFixture[str]) -> None:
    texts = [run(capsys, "learn").out, run(capsys, "learn", "--json").out]
    texts += [resolve(path) for path in known_paths()]
    for text in texts:
        assert not TEMPLATE_WORDING.search(text), TEMPLATE_WORDING.search(text).group(0)
        assert "culture-agents whoami" not in text  # the CLI is `agents`, not `culture-agents`


def test_learn_and_overviews_list_every_registered_verb(
    capsys: pytest.CaptureFixture[str],
) -> None:
    learn = run(capsys, "learn", "--json").json()
    listed = {tuple(c["path"]) for c in learn["tools"]}
    assert listed == _tool_paths()  # agentfront's learn lists exactly the registry
    meta = [("learn",), ("explain",), ("overview",), ("doctor",)]
    text = run(capsys, "learn").out
    for path in _tool_paths():
        assert f"  - {' '.join(path)}: " in text
    for path in meta:  # the meta-verbs are not registry tools; our learn section names them
        assert f"agents {' '.join(path)} - " in text
    cli = run(capsys, "cli", "overview", "--json").json()
    verbs = next(s for s in cli["sections"] if s["title"] == "Verbs")["items"]
    assert len(verbs) == len(listed) + len(meta)


def test_json_errors_carry_the_triple(capsys: pytest.CaptureFixture[str]) -> None:
    r = run(capsys, "runs", "nope", "--json")
    assert r.rc == 1
    assert {"code", "message", "remediation"} <= set(r.err_json())


def test_bare_noun_groups_list_their_verbs(capsys: pytest.CaptureFixture[str]) -> None:
    for noun in ("runs", "agents"):
        r = run(capsys, noun)
        assert r.rc == 0
        assert f"Available commands in {noun}" in r.out
