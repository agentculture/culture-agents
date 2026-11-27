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
dispatch, persistent sessions and runs, and lifecycle control over harness
adapters, **independent of chat**. It ships as two packages from one repo: the
TypeScript core `@culture.dev/agents` (`core/`, Node 22 or newer) and the
Python CLI `agents` (package `culture_agents`, PyPI dist `culture-agents`),
which is a client of the core over a Unix socket.

**Current state:** the D1 slice plus D2 part one, a single-host control plane without chat.

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
  submit|list|show|attach|steer|cancel|logs|result|answer`, `agents branches list|remove`, plus `whoami`, `learn`,
  `explain`, `overview`, `doctor`, `cli overview`. With no core running they
  exit 2 with a hint.
- D2 part one (single host, `docs/d2/part-one.md`): after a restart the core takes
  back live control of surviving workers; several runs may be active in one
  repository (no limit unless the operator configures one, then `limit_reached`);
  a repeated idempotency key on submit, steer or cancel takes effect once; a
  run's question waits on disk and is answered once with `agents runs answer`
  (stub harness only: Claude Code and OpenCode have no ask path and report
  `answer` unsupported); run branches can be listed and removed; the capability
  report shows limits, active runs and the heat signal, and for OpenCode the
  model gateway's admission; tracing to a local Langfuse (endpoint path
  unconfirmed). Steer is **not preemption**: it lands in the running turn.
  `succeeded` means the turn ended cleanly, not that the task was done. No
  hold of 12 hours was measured (the longest was 5 minutes). Acceptance is
  `tests/acceptance/d2/` and `docs/d2/part-one-acceptance.md`; its live rows
  are NOT VERIFIED until filled in.
- `docs/d0/` has the inventory, compatibility matrix, decision records and
  probe results; `docs/specs/` and `docs/plans/` hold the confirmed spec and
  plan; `spikes/` is throwaway probe code, never built or checked.

**Not built:** D2 part two (more than one host: fleet view, placement,
fetching a run's commits from another host) (planned), D3 through D6, `pause`,
`resume` and delegation (both answer `unsupported`), `artifacts` (no route or
verb) (planned), an ask path in the Claude Code and OpenCode drivers, Codex,
chat integration. Nothing is archived: recovery is the condition for archiving
`agent-lifecycle` and `cultureagent`. Issue
[#2](https://github.com/agentculture/culture-agents/issues/2) is the
authoritative plan; `docs/d0/decisions.md` lists open decisions. Never
describe unbuilt verbs as available.
The network transport between cores is the one piece of part two on disk:
`core/src/fleet/` (TLS 1.3, both sides authenticated by Ed25519 key against a
local trust list; `docs/d2/fleet-transport.md`). It is off unless
`CULTURE_AGENTS_FLEET_LISTEN` is set, and so far it serves members only the
version route.

## Plan and boundaries

Boundaries (from [#1](https://github.com/agentculture/culture-agents/issues/1)
and #2): culture-agents owns agent execution and direct control; culture-chat
owns rooms, messages and presence; culture-rules owns workflows; embodiment
stays an independent app built on culture-agents. Agents exist without chat,
and a dead chat server must not kill a run. AI SDK types never leak into the
public contract. Safety defaults: dispatch permission is empty/deny, authority
is enforced server-side and never granted by a prompt, memory, chat and
subagent output are untrusted data never treated as control commands, and
worktrees are not security sandboxes.

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
python3 scripts/check-example-node.py     # ids and node fields name only the example node, thor
uv run python scripts/harness-smoke.py --stage config --require config
```

The core and the CLI share the socket path: `$CULTURE_AGENTS_SOCKET`, else
`$XDG_RUNTIME_DIR/culture-agents/core.sock`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock` (never under `/tmp`).
The control API is version 3.0 (`contract/api.json`): it holds the D2 part one shapes, and
`contract/README.md` marks the behaviour that is not built yet as (planned).

## How the code is laid out

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
- **The vendored skills under `.claude/skills/` are cited verbatim** from
  guildmaster. Never edit them; fix them upstream.
- **Worktrees** go in `../.worktrees.culture-agents/<name>/`, with a
  work-scoped branch prefix. Never use a shared `../worktrees/`.
- **Keep docs grounded in what is on disk**, and mark anything ahead of
  reality as planned.
