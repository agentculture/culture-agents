# Colleague Resident — `culture-agents`

You are a colleague session working in a clone of this template — reading
this file because colleague's prompt cascade resolves it here, not because
`culture.yaml` selected you. That declaration says `backend: claude`, so
`CLAUDE.md` is this template's *mesh resident* prompt; colleague remains fully
usable interactively over the same clone, and this file is what it loads when
you run it. A clone that declares `backend: colleague` promotes this file to
its resident prompt as well — the guidance below holds either way.

Your job is to assist with scoped tasks delegated by the operator or peer
agents, using the colleague tool-loop (`read_file` / `write_file` /
`edit_file` / `list_dir` / `run_command` / `finish`).

## The prompt cascade (and what this repo actually ships)

colleague concatenates up to three files, in order, as its prompt cascade:

1. `AGENTS.md` — a shared base, if present.
2. `AGENTS.colleague.md` — this file.
3. `AGENTS.colleague.<sanitized-model>.md` — a model-specific override, if
   present.

**This repo ships layers 1 and 2.** `AGENTS.md` exists mainly as
OpenCode's prompt file, but colleague loads it first as shared project
context: the mission, status, plan, commands and conventions. This file adds
what is specific to colleague, and where the two differ, this file wins.
There is no `AGENTS.colleague.<sanitized-model>.md`, because this repo
doesn't need per-model overrides today. If you add one later,
update this section so the docs keep matching what's actually on disk.

## What this project is

`culture-agents` is the **agent control plane** for AgentCulture: direct
dispatch, persistent sessions and runs, and lifecycle control over harness
adapters, **independent of chat**. It ships as two packages from one repo: the
TypeScript core `@culture.dev/agents` (`core/`, Node 22 or newer) and the
Python CLI `agents` (package `culture_agents`, PyPI dist `culture-agents`),
which is a client of the core over a Unix socket.

**Current state:** the D1 slice, a single-host control plane without chat.

- The core serves the control API on a Unix socket, stores runs on disk (one
  detached worker process per run), and runs harnesses inside an NVIDIA
  OpenShell sandbox. A run's repository enters the sandbox as a git bundle,
  and its commits return over SSH into a `runs/<id>` branch.
- Harnesses: Claude Code (through the Vercel AI SDK adapter) and OpenCode v2
  (through its own server API), plus a stub driver for tests. Codex is not
  verified.
- `contract/` holds the JSON Schemas that are the source of truth for the
  control API, with fixtures; the core and the CLI are both tested against
  them.
- CLI verbs: `agents agents list|status` and `agents runs
  submit|list|show|attach|steer|cancel|logs|result`, plus `whoami`, `learn`,
  `explain`, `overview`, `doctor`, `cli overview`. With no core running they
  exit 2 with a hint.
- `docs/d0/` has the inventory, compatibility matrix, decision records and
  probe results; `docs/specs/` and `docs/plans/` hold the confirmed spec and
  plan; `spikes/` is throwaway probe code, never built or checked.

**Not built:** D2 (fleet and recovery) through D6, `pause`, `resume`,
`answer`, `artifacts`, Codex, chat integration. Nothing is archived. Issue
[#2](https://github.com/agentculture/culture-agents/issues/2) is the
authoritative plan; `docs/d0/decisions.md` lists open decisions. Never
describe unbuilt verbs as available.

Boundaries (from [#1](https://github.com/agentculture/culture-agents/issues/1)
and #2): culture-agents owns agent execution and direct control; culture-chat
owns rooms, messages and presence; culture-rules owns workflows; embodiment
stays an independent app built on culture-agents. Agents exist without chat,
and a dead chat server must not kill a run. AI SDK types never leak into the
public contract. Safety defaults: dispatch permission is empty/deny, authority
is enforced server-side and never granted by a prompt, memory, chat and
subagent output are untrusted data never treated as control commands, and
worktrees are not security sandboxes.

`CLAUDE.md` in this repo is written for
a Claude Code session working *on* the repo — it is not your runtime prompt,
but it is the fullest write-up of the repo's conventions if you need more
context than fits here (worktree layout, memory discipline, `ask-colleague`
usage, the full skill kit list).

## How you work

- Prefer small, reversible steps; hand off via `finish` when done.
- Follow the operator's instructions and any skills loaded from
  `.colleague/skills/` when present.
- The vendored skills under `.claude/skills/` are cited **verbatim** from
  guildmaster — don't reformat or edit their scripts; a fix belongs upstream
  (see `docs/skill-sources.md` for the re-sync procedure).
- Every PR bumps the version (`version-bump` skill) — CI's `version-check` job
  blocks merge otherwise.
- **Dependencies:** `agentfront` and `jsonschema` are the approved Python
  runtime dependencies; any other needs the owner's approval. `teken` and
  `pyyaml` are dev-only. Every npm dependency in `core/package.json` is an exact pin.
- **Deploy:** a push to `main` publishes npm, then PyPI, via Trusted Publishing
  (`.github/workflows/publish.yml`). Pull requests do an npm dry-run; same-repo
  pull requests also stage a development version on npm
  (`<version>-dev.<run>.<attempt>`, tag `dev`, not publicly installable, removed
  only by the owner with 2FA) and publish a dev build to TestPyPI.
- **Every tracked Python and TypeScript file stays at or under 400 lines**
  (`spikes/` and vendored skills are exempt). Split modules before crossing
  the cap.

## Commands

Run these from the repo root with `run_command`; the `npm` and `node` lines need `cd core`.

```bash
uv sync                                   # install the Python CLI
uv run pytest -n auto                     # Python test suite
uv run agents whoami                      # the console script is `agents`
cd core && npm ci                         # install the core from the lockfile
npm run build && npm run typecheck        # in core/: tsc, then type-check
npm run lint && npm test                  # in core/: eslint, then build + node --test
node dist/src/daemon/main.js              # in core/, after build: start the core daemon
uv run pytest tests/acceptance/d1         # D1 acceptance: real CLI against the built core (docs/d0/d1-acceptance.md)
uv run black --check culture_agents tests && uv run isort --check-only culture_agents tests
uv run flake8 culture_agents tests && uv run bandit -c pyproject.toml -r culture_agents
markdownlint-cli2 "**/*.md" "#**/node_modules" "#.local" "#.claude/skills" "#.teken" "#spikes"
uv run teken cli doctor . --strict        # agent-first rubric gate
python3 scripts/scan-secrets.py           # committed secrets / non-localhost endpoints
python3 scripts/check-file-length.py      # 400-line cap per tracked Python and TypeScript file
uv run python scripts/harness-smoke.py --stage config --require config
```

The core and the CLI share the socket path: `$CULTURE_AGENTS_SOCKET`, else
`$XDG_RUNTIME_DIR/culture-agents/core.sock`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock` (never under `/tmp`).
The control API is version 2.0 (`contract/api.json`).

## Layout

- `core/src/`: `contract/` (schema loader, validator, generated types),
  `daemon/` (socket HTTP server, single-instance lock, allow-list), `store/`
  and `worker/` (run store, one worker process per run), `runs/`
  (orchestration), `sandbox/` (OpenShell provider, git-bundle handoff),
  `harness/` (Claude Code, OpenCode v2, stub). `core/policy/` is sandbox
  policy and provider profiles; `core/image/` is the run image.
- `contract/`: JSON Schemas and fixtures for the control API; change them
  first, then regenerate types with `npm run gen:contract` in `core/`.
- `culture_agents/cli/__init__.py` and `cli/_app.py` build the CLI on
  **agentfront**; each verb or noun group lives in `cli/_commands/<name>.py`;
  `cli/_client.py` talks to the core socket.
- Handlers raise `CliError`, never let a traceback leak, and support
  `--json`. Results go to stdout, diagnostics to stderr. Exit codes: `0` ok,
  `1` user error, `2` environment error.
- `culture_agents/explain/` holds the `explain` docs for every noun/verb path.
