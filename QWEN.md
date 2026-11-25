# QWEN.md

This file provides guidance to Qwen Code when working with code in this
repository. Qwen Code's context loader reads both `QWEN.md` and `AGENTS.md`
in a directory, and this repo ships both. `AGENTS.md` is mainly OpenCode's
file and holds harness-neutral project context. This file adds what is
specific to Qwen Code, and where the two differ, this file wins.

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

It is a sibling to [`guildmaster`](https://github.com/agentculture/guildmaster)
(the **skills supplier**), [`steward`](https://github.com/agentculture/steward)
(**alignment** — `steward doctor`, the sibling-pattern baseline), and
[`teken`](https://github.com/agentculture/teken) (the **afi-cli** "Agent First
Interface" scaffolder this CLI is cited from) within the Organic Development
framework.

## Prompt files by harness

Which root files each agent harness reads:

- **Claude Code** → [`CLAUDE.md`](CLAUDE.md) (the fullest write-up; read it
  first if you are new to the repo).
- **Pi / associate** → [`AGENTS.override.md`](AGENTS.override.md) for context,
  plus [`.pi/SYSTEM.md`](.pi/SYSTEM.md) for its system prompt.
- **colleague** → [`AGENTS.md`](AGENTS.md), then
  [`AGENTS.colleague.md`](AGENTS.colleague.md).
- **Qwen Code** → this file plus [`AGENTS.md`](AGENTS.md).
- **OpenCode** → [`AGENTS.md`](AGENTS.md), which it prefers over `CLAUDE.md`.

## Identity

Declared in `culture.yaml`:

```yaml
agents:
- suffix: culture-agents
  backend: claude
```

`backend: claude` fixes the *mesh resident* prompt file to `CLAUDE.md` — the
mesh runtime reads that file, not this one. A Qwen Code session working in a
clone of this repo is a separate, local tool session; it reads `QWEN.md`
regardless of what `culture.yaml` declares, and running Qwen Code here neither
requires nor changes that declaration. The declaration and the resident prompt
together satisfy the two invariants `steward doctor` verifies:
**prompt-file-present** and **backend-consistency** (`claude` ↔ `CLAUDE.md`).

## Plan and boundaries

Sourced from [#1](https://github.com/agentculture/culture-agents/issues/1) and
[#2](https://github.com/agentculture/culture-agents/issues/2).

Boundaries (from [#1](https://github.com/agentculture/culture-agents/issues/1)
and #2): culture-agents owns agent execution and direct control; culture-chat
owns rooms, messages and presence; culture-rules owns workflows; embodiment
stays an independent app built on culture-agents. Agents exist without chat,
and a dead chat server must not kill a run. AI SDK types never leak into the
public contract. Safety defaults: dispatch permission is empty/deny, authority
is enforced server-side and never granted by a prompt, memory, chat and
subagent output are untrusted data never treated as control commands, and
worktrees are not security sandboxes.

## The CLI

The CLI is built on **agentfront** (one registry of verbs and docs) from code
cited from teken's `python-cli` reference. Agent-first verbs:

- `agents whoami` — identity from `culture.yaml`.
- `agents learn` — structured self-teaching prompt.
- `agents explain <path>` — markdown docs for any noun/verb.
- `agents overview` — descriptive snapshot of the agent.
- `agents doctor` — check the agent-identity invariants.
- `agents cli overview` — describe the CLI surface itself.

Control-plane verbs, clients of the core socket: `agents agents list|status`
and `agents runs submit|list|show|attach|steer|cancel|logs|result`.

Conventions: every command supports `--json`; results go to stdout, errors and
diagnostics to stderr (never mixed); exit codes are `0` success, `1` user
error, `2` environment error, `3+` reserved. The agent-first rubric is
enforced in CI by `teken cli doctor . --strict`.

## Skills

`.claude/skills/` vendors the **canonical guildmaster skill kit**
(cite-don't-import). Provenance and the re-sync procedure live in
`docs/skill-sources.md`. Do not reformat or edit vendored scripts — re-sync
from guildmaster instead.

## Conventions

- **Every PR bumps the version** — even docs/config/CI. Use the
  `version-bump` skill; the `version-check` CI job blocks merge otherwise.
- **Dependencies:** `agentfront` and `jsonschema` are the approved Python
  runtime dependencies; any other needs the owner's approval. `teken` and
  `pyyaml` are dev-only. Every npm dependency in `core/package.json` is an exact pin.
- **Every tracked Python and TypeScript file stays at or under 400 lines**
  (`spikes/` and vendored skills are exempt). Split modules before crossing
  the cap.
- **Deploy**: pushing to `main` publishes npm (skipped while
  `core/package.json` is `0.0.0`) and then PyPI via Trusted Publishing
  (`.github/workflows/publish.yml`); PRs do a TestPyPI dry-run.

## Commands

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

```text
core/                     TypeScript core @culture.dev/agents (Node 22+)
  src/                    contract, daemon, store, worker, runs, sandbox, harness
  policy/  image/         sandbox policy and provider profiles; run image
  test/                   node:test suites
contract/                 JSON Schemas + fixtures for the control API
culture_agents/           `agents` CLI, built on agentfront (one App registry)
  cli/                    _app.py registry, socket client, error/output contract, _commands/
  explain/                markdown catalog for `explain`
tests/                    pytest suite
scripts/                  harness-smoke, scan-secrets, check-file-length
docs/d0/                  inventory, compatibility matrix, decisions, probe results
docs/specs/ docs/plans/   the confirmed spec and plan
spikes/                   throwaway probe code (never built or checked)
.claude/skills/           vendored guildmaster skill kit (cite-don't-import)
docs/skill-sources.md     skill provenance ledger
culture.yaml              mesh identity (suffix + backend)
.github/workflows/        tests (python + core jobs) + deploy (npm, then PyPI)
```

This file describes the repository **as it exists on disk today**. When you
edit, keep claims grounded in checked-in reality; if a section drifts ahead of
reality, mark it `(planned)`. For the
full set of workflow conventions (worktree layout, memory discipline,
`ask-colleague` usage), see [`CLAUDE.md`](CLAUDE.md) — those conventions apply
to work in this repo regardless of which harness is doing it.
