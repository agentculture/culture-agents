# AGENTS.override.md

This file is the **context layer** for the Pi harness (the `pi` CLI, and the
`associate` non-coding harness modelled on it) when it runs inside this repo.
Pi's CONTEXT loader concatenates `AGENTS.md` or `CLAUDE.md` from its user-level
config directory (see Pi's own docs), each parent directory, and the working
directory — but an `AGENTS.override.md`
present in a directory replaces that directory's `AGENTS.md`/`CLAUDE.md` entry
outright rather than adding to it. That is why this repo ships this file:
Pi must inherit neither `CLAUDE.md` (the Claude Code guidance file) nor
`AGENTS.md` (OpenCode's file, also loaded by colleague and Qwen Code). Both
assume a coding session with repo-write authority that Pi's non-coding lane
does not have.

The identity and behavioral bounds for that lane — who Pi is here, what it may
and may not do — live one layer up, in Pi's **system prompt** file,
[`.pi/SYSTEM.md`](.pi/SYSTEM.md). That file replaces Pi's default
coding-assistant system prompt entirely. This file is project *context* only:
what the repo is and how it is laid out, not who is reading it.

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

Pi's lane here is non-coding, so these are for reference when you explain how
the repo is built and tested. Describe them; do not run them.

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

## Five harnesses and their files

- **Claude Code** reads [`CLAUDE.md`](CLAUDE.md).
- **OpenCode** reads [`AGENTS.md`](AGENTS.md), which it prefers over
  `CLAUDE.md`.
- **Pi / associate** reads this file (`AGENTS.override.md`) for context, plus
  [`.pi/SYSTEM.md`](.pi/SYSTEM.md) for its system prompt. It never sees
  `AGENTS.md`.
- **colleague** reads `AGENTS.md` and then
  [`AGENTS.colleague.md`](AGENTS.colleague.md) (its cascade; see that file).
- **Qwen Code** reads [`QWEN.md`](QWEN.md) and `AGENTS.md`.

If you are reading this as a human, `CLAUDE.md` is the fullest write-up of the
repo's conventions and is the one to read first. The other files exist so
that no harness silently inherits instructions written for a different one.

## Identity

Declared in `culture.yaml`:

```yaml
agents:
- suffix: culture-agents
  backend: claude
```

This template's *mesh* resident runs on `backend: claude`, so `CLAUDE.md` is
the live resident prompt. A Pi session working in a clone of this repo is a
**local tool session**, not the mesh resident — it reads this file and
`.pi/SYSTEM.md` regardless of what `culture.yaml` declares, and running `pi`
here neither requires nor changes that declaration.

(A clone that wants `associate` as its *mesh* resident declares
`backend: colleague` with `model: associate` — see `docs/skill-sources.md`.
That is a per-clone choice; this template does not ship it.)

## Layout (what you can read/find/summarize here)

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
scripts/                  harness-smoke, scan-secrets, check-file-length, check-example-node
docs/d0/                  inventory, compatibility matrix, decisions, probe results
docs/specs/ docs/plans/   the confirmed spec and plan
spikes/                   throwaway probe code (never built or checked)
.claude/skills/           vendored guildmaster skill kit (cite-don't-import)
docs/skill-sources.md     skill provenance ledger
culture.yaml              mesh identity (suffix + backend)
.github/workflows/        tests (python + core jobs) + deploy (npm, then PyPI); PRs stage a dev version on npm
```

## Conventions worth knowing before you answer a question about this repo

- The vendored skills under `.claude/skills/` are cited **verbatim** from
  guildmaster — never propose editing their scripts; the fix belongs upstream
  (`docs/skill-sources.md` has the re-sync procedure).
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
- Every PR bumps the version (`version-bump` skill); CI's `version-check` job
  blocks merge otherwise.
- This file describes the repo **as it exists on disk today**. If you are
  asked to update it, keep claims grounded in checked-in reality.
