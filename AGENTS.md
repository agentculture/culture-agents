# AGENTS.md

This file gives project guidance to **OpenCode** when it works in this
repository. OpenCode reads the `AGENTS.md` of each directory in preference to
that directory's `CLAUDE.md`, so this file, not `CLAUDE.md`, is what OpenCode
loads here.

Other harnesses also pick this file up, so it stays harness-neutral project
context:

- **colleague** loads it as layer 1 of its cascade (`AGENTS.md` →
  `AGENTS.colleague.md`).
- **Qwen Code** loads it alongside `QWEN.md`.
- **Pi** does not read it, because `AGENTS.override.md` replaces it for this
  directory.
- **Claude Code** does not read it either; Claude Code reads `CLAUDE.md`.

If your harness has its own file (see
[Prompt files by harness](#prompt-files-by-harness)), that file's guidance
takes precedence where the two differ.

## What this project is

`culture-agents` is the **agent control plane** for AgentCulture: direct
dispatch, sessions and runs, and lifecycle control (dispatch, attach, steer,
delegate, pause/resume, cancel, answer, supervise) over harness adapters,
**independent of chat**. The CLI ships as `agents`, the Python package is
`culture_agents`, and the PyPI dist is `culture-agents`.

**Status: scaffold only.** guildmaster provisioned the repo from
`culture-agent-template`. Today it holds:

- the agent-first CLI baseline (`whoami`, `learn`, `explain`, `overview`,
  `doctor`, `cli overview`);
- the mesh identity in `culture.yaml` (`suffix: culture-agents`,
  `backend: claude`);
- the harness prompt files;
- the vendored skill kit;
- CI.

**None of the control-plane surface exists yet.** Never describe planned
verbs as available.

## The plan (not built)

Sourced from [#1](https://github.com/agentculture/culture-agents/issues/1)
(founding brief) and
[#2](https://github.com/agentculture/culture-agents/issues/2) (design and
migration). Read #2 before designing anything.

- **Boundaries.** culture-agents owns agent execution and direct control.
  culture-chat owns rooms, messages and presence. culture-rules owns
  workflows and calls culture-agents when it needs an agent. embodiment stays
  an independent app built on culture-agents.
- **Agents exist without chat.** Agents dispatch other agents directly
  through this repo's control API. A dead chat server must not kill a run.
- **Harness adapters.** Vercel AI SDK 7 `HarnessAgent` (Claude Code, Codex,
  OpenCode, Pi) replaces custom harness glue only where it proves equivalent
  on the real fleet, and stays behind an adapter boundary. AI SDK types never
  leak into the public contract.
- **Consolidation.** `agent-lifecycle` (supervision) and `cultureagent`
  (harness wrappers) merge in here. Neither is archived until this repo
  passes compatibility and recovery tests.
- **Proposed verbs:** `agents runs submit | list | show | attach | steer |
  pause | resume | cancel | answer | logs | artifacts | result`.
- **Gates.** D0 (inventory, contract, and the open TypeScript-vs-Python
  decision) through D6 (migration and deprecation). Don't add a Node/TS
  runtime before D0 decides it.
- **Safety defaults.** Dispatch permission is empty/deny, and authority is
  enforced server-side, never granted by a prompt. Memory, chat and subagent
  output are untrusted data, never control commands. Worktrees are not
  security sandboxes.

## Commands

```bash
uv sync                                   # install
uv run pytest -n auto                     # full test suite
uv run pytest tests/test_cli.py -k whoami # one file / one test
uv run agents whoami                      # the console script is `agents`
uv run black --check culture_agents tests && uv run isort --check-only culture_agents tests
uv run flake8 culture_agents tests && uv run bandit -c pyproject.toml -r culture_agents
uv run teken cli doctor . --strict        # agent-first rubric gate
python3 scripts/check-file-length.py      # 400-line cap per tracked Python file
uv run python scripts/harness-smoke.py --stage config --require config
```

## How the code is laid out

- `culture_agents/cli/__init__.py` builds the argparse tree. Each verb or
  noun group lives in `cli/_commands/<name>.py` with a `register(subparsers)`
  function. Future noun groups such as `runs` register in `_build_parser()`.
- Handlers raise `CliError`, never let a traceback leak, and support
  `--json`. Results go to stdout, diagnostics to stderr. Exit codes: `0` ok,
  `1` user error, `2` environment error.
- The runtime package has **zero third-party dependencies**. `teken` and
  `pyyaml` are dev-only.
- `culture_agents/explain/catalog.py` holds the `explain` docs for every
  noun/verb path.

## Prompt files by harness

| Harness | Reads |
| --- | --- |
| Claude Code | `CLAUDE.md` (the fullest write-up of conventions) |
| OpenCode | `AGENTS.md` (this file); skills from `.claude/skills` natively |
| Pi / associate | `AGENTS.override.md` + `.pi/SYSTEM.md` |
| colleague | `AGENTS.md` → `AGENTS.colleague.md` |
| Qwen Code | `QWEN.md` + `AGENTS.md` |

When you change what the repo is or how it works, update every one of these
files so they don't drift. `scripts/harness-smoke.py` checks that each
harness's files exist, aren't empty, and are registered.

## Conventions

- **Every PR bumps the version** (the `version-bump` skill). CI's
  `version-check` job blocks merge otherwise.
- **Every tracked Python file stays at or under 400 lines.** Split modules
  before crossing the cap.
- **The vendored skills under `.claude/skills/` are cited verbatim** from
  guildmaster. Never edit them; fix them upstream.
- **Worktrees** go in `../.worktrees.culture-agents/<name>/`, with a
  work-scoped branch prefix. Never use a shared `../worktrees/`.
- **Keep docs grounded in what is on disk**, and mark anything ahead of
  reality as planned.
