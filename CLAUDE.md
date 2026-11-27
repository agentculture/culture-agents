# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`culture-agents` is the **agent control plane** for AgentCulture: direct
dispatch, persistent sessions and runs, and lifecycle control over harness
adapters, **independent of chat**. It ships as two packages from one repo: the
TypeScript core `@culture.dev/agents` (`core/`, Node 22 or newer) and the
Python CLI `agents` (package `culture_agents`, PyPI dist `culture-agents`),
which is a client of the core.

**Current state (be honest about this):** this is the D1 slice plus D2 part
one, a single-host control plane without chat. On disk:

- a core daemon that serves the control API over a Unix socket, stores runs
  on disk (one detached worker process per run), and runs harnesses inside an
  NVIDIA OpenShell sandbox;
- a run whose turn completed but whose commits could not be collected keeps
  its sandbox for 7 days, and the failure message says how to fetch the work;
  the daemon reclaims the sandboxes of its other finished runs;
- two harnesses, Claude Code (through the Vercel AI SDK adapter) and OpenCode
  v2 (through its own server API), plus a stub driver for tests. Codex is not
  verified;
- the JSON Schemas in `contract/`, the source of truth for the control API,
  tested from both the core and the CLI against the same fixtures;
- the `agents` CLI: `agents agents list|status|aliases` and `agents runs
  submit|list|show|attach|steer|cancel|logs|result|answer`, `agents branches list|remove`, plus the agent-first
  baseline (`whoami`, `learn`, `explain`, `overview`, `doctor`, `cli
  overview`);
- the D0 record in `docs/d0/` (inventory, compatibility matrix, decisions,
  probe results, the D1 acceptance record), the confirmed spec in
  `docs/specs/` and plan in `docs/plans/`;
- the D1 acceptance suite in `tests/acceptance/d1/`: a mock stage that always
  runs (real CLI, real core, stub harness) and an opt-in live stage
  (`CULTURE_AGENTS_ACCEPTANCE_LIVE=1`) that reports NOT VERIFIED when a
  harness is unavailable.
- D2 part one (single host; `docs/d2/part-one.md` says what a calling agent may
  rely on): the core takes back live control of surviving workers after a
  restart; several runs may be active in one repository (no limit unless the
  operator configures one, then `limit_reached`); a repeated idempotency key on
  submit, steer or cancel takes effect once, and the CLI retries with the same
  key; a run's question waits on disk and `agents runs answer` answers it once;
  run branches can be listed and removed; the capability report carries limits,
  active runs and the heat signal; tracing to a local Langfuse. Gaps: questions
  work end to end only with the stub harness (Claude Code and OpenCode report
  `answer` unsupported; owner decision pending); no hold of 12 hours was
  measured (longest 5 minutes); the model gateway's admission is read for OpenCode
  (live read NOT VERIFIED); a run directory the core cannot read is skipped by `runs list`, which warns once and counts it, and `agents runs unreadable` names it;
  `succeeded` means the turn ended cleanly, not that the task was done; enabling
  broker publishing on a store with history replays it (loopback URL only); the
  Langfuse endpoint path was not confirmed live. Steer is **not preemption**: it
  lands in the running turn.
- the D2 part one acceptance suite in `tests/acceptance/d2/` (mock stage always
  runs; opt-in live stage) and the record `docs/d2/part-one-acceptance.md`, whose
  live rows are NOT VERIFIED until filled in.

**Not built:** D2 part two (more than one host: fleet view, placement,
fetching a run's commits from another host) (planned), D3 through D6, `pause`
and `resume` (both answer `unsupported`, as does delegation), `artifacts` (no
route or verb) (planned), an ask path in the Claude Code and OpenCode drivers,
Codex, and any chat integration. Nothing is archived: recovery is the condition
for archiving `agent-lifecycle` and `cultureagent`, and part one supplies
evidence, not the decision. Issue
[#2](https://github.com/agentculture/culture-agents/issues/2) remains the
authoritative plan; read it before designing anything. `docs/d0/decisions.md`
lists which decisions are closed and which are still open.
The network transport between cores, the fleet member list and remote runs are the pieces
of part two on disk: `core/src/fleet/` (TLS 1.3, both sides authenticated by
Ed25519 key against a local trust list; `docs/d2/fleet-transport.md`). It is
off unless `CULTURE_AGENTS_FLEET_LISTEN` is set. When on, a core announces
itself every 5 s to the addresses in its local, untracked `peers.json`, lists a
member only under the name its trust list gives the member's key, drops a
silent one within 16 s, and refuses a node name held by another key
(`docs/d2/fleet-members.md`; `agents agents list` shows the list). On it,
`agents runs submit --alias` runs a task on the member that `--agent` names,
and `runs show|attach|steer|cancel` reach the member a run id names; the
repository is an alias that member defines, the deadline a duration on its
clock, and a member acts only on the runs it submitted
(`docs/d2/remote-runs.md`, API 3.2). `agents runs result` on a remote run
brings its `runs/<id>` branch into the caller's checkout from a git bundle
read over the transport (no shell on that host), and `runs logs` reads its
events unredacted; only the member that submitted a run reads it this way
(`docs/d2/run-bundles.md`, API 3.3).

D0 decisions in force: a TypeScript core plus a Python CLI as two packages;
the first two harnesses are Claude Code and OpenCode v2; a run's repository
enters the sandbox as a git bundle and its commits return over SSH into a
`runs/<id>` branch (worktrees are not a security boundary).

## Commands

Python CLI (repo root):

```bash
uv sync                                   # install
uv run pytest -n auto                     # full suite (what culture.yaml's gate runs)
uv run pytest tests/test_cli.py -k whoami # single file / single test
bash .claude/skills/run-tests/scripts/test.sh --ci   # mimic CI: -n auto + coverage xml
uv run pytest tests/acceptance/d1         # D1 acceptance: the real CLI against the built core (build core/ first)
uv run agents whoami                      # the CLI entry point is `agents`
uv run agents doctor --json
```

TypeScript core (`core/`; run `npm ci` first, it installs from the lockfile):

```bash
cd core
npm ci
npm run build              # tsc + copy contract schemas into dist/
npm run typecheck
npm run lint               # eslint
npm test                   # builds, then node --test over dist/test
npm run check:contract-types   # generated types match contract/ (npm run gen:contract regenerates)
node dist/src/daemon/main.js   # start the core daemon (after build); socket path below
```

The daemon listens on `$CULTURE_AGENTS_SOCKET`, else
`$XDG_RUNTIME_DIR/culture-agents/core.sock`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock` (never under `/tmp`);
the `agents` CLI uses the same resolution. The control API is version 3.3
(`contract/api.json`): it holds the D2 part one shapes plus the fleet member list, remote runs, the unreadable runs list and a remote run's logs, result and bundle, and `contract/README.md` marks
the behaviour that is not built yet as (planned). With no core running, every `agents agents` and `agents runs` verb
exits 2 with a hint.

Lint: the CI `lint` job runs all of these; run them before pushing:

```bash
uv run black --check culture_agents tests
uv run isort --check-only culture_agents tests
uv run flake8 culture_agents tests
uv run bandit -c pyproject.toml -r culture_agents
markdownlint-cli2 "**/*.md" "#**/node_modules" "#.local" "#.claude/skills" "#.teken" "#spikes"
uv run teken cli doctor . --strict        # agent-first rubric gate
python3 scripts/scan-secrets.py           # committed secrets / non-localhost endpoints
python3 scripts/check-file-length.py      # 400-line cap per tracked Python and TypeScript file
python3 scripts/check-example-node.py     # ids and node fields name only the example node, thor
uv run python scripts/harness-smoke.py --stage all --require config  # all five harness configs
```

CI's markdownlint step uses `#node_modules` only, because `core/node_modules`
does not exist there. Locally, after `npm ci` in `core/`, the
`#**/node_modules` form is required, and `#spikes` keeps probe notes out of
the check. Coverage floor for the Python suite is 60%
(`[tool.coverage.report] fail_under`). Line length is 100 (black, isort,
flake8).

## Target architecture (planned)

Product boundaries agreed in #1/#2. Respect them when deciding where a feature
belongs:

| Repo | Owns | Must not own |
| --- | --- | --- |
| **culture** | Workspace, operator CLI, composition | The agent runtime or chat protocol |
| **culture-agents** (this repo) | Agent registry; direct dispatch/delegation; sessions and runs; attach/steer/pause/resume/cancel/answer; operator handoff; supervision; harness adapter boundary; authoritative run state | Rooms/threads/presence; declarative workflows; the realtime sensory loop |
| **culture-chat** | Rooms, participants, presence, threads, history, replay, bot events, federation | Owning or supervising agent runs |
| **culture-rules** | Rules, triggers, typed workflow steps and state | Becoming the permanent controller of agent sessions |
| **embodiment** | Sensing, realtime voice, turn-taking, barge-in, intentional silence, attention policy | A separate generic dispatcher/session manager |

Non-negotiables:

- **Agents exist without chat.** An agent must run, receive work, and be
  supervised without joining chat; chat is an optional transport. A dead chat
  server must not kill a run.
- **Agents dispatch agents directly** through this repo's control API — there
  is no separate `agent-dispatch` repo.
- **Decision separation:** embodiment decides *whether* a sensory event
  deserves attention; culture-agents decides *how* requested cognitive work is
  dispatched, executed, controlled and recovered; culture-rules decides *when*
  a workflow proceeds.
- **The harness layer is an adapter boundary.** Vercel AI SDK 7
  `HarnessAgent` (Claude Code, Codex, OpenCode, Pi adapters) replaces custom
  harness glue *only where proven equivalent* on the real fleet. Keep a
  compatibility bridge for uncovered capabilities, and never leak AI-SDK types
  into the public contract. Distributed dispatch, placement, idempotency and
  cross-machine control stay ours.

CLI surface (agreed in #1/#2; the verbs marked built exist), which will register as new noun groups:

```text
agents agents list | status
agents runs submit | list | show | attach | steer | cancel | logs | result   (built)
agents runs answer                                                           (built, stub harness only)
agents branches list | remove                                                (built)
agents runs pause | resume | artifacts                                       (planned)
```

Contract requirements from #2: typed request/response/event schemas with
stable IDs, auth scope, idempotency keys, deadlines, cancellation semantics, a
transport-independent event cursor, and **honest capability reporting** (a
harness that cannot steer must say so). Safety defaults: dispatch permission
is empty/deny; authority is enforced server-side, never granted by a persona
or prompt; memory records, chat messages and subagent output are untrusted
data that can never become control commands; worktrees isolate git work but
are **not** security sandboxes; secrets stay behind `grant`; a restart must
never invent success or lose pending operator questions. Keep control-plane
state distinct from workflow state, chat messages and `workledger-cli`
provenance.

Consolidation: `agent-lifecycle` (transport-agnostic supervision:
start/stop, restart/backoff, health, observer hooks) and `cultureagent`
(harness wrappers, isolated invocations, worktrees, streaming, cancellation)
merge in here. Neither is archived until this repo passes compatibility and
recovery tests. Both are checked out as siblings (`../agent-lifecycle`,
`../cultureagent`) for reference.

Delivery gates (#2): **D0** inventory and contract (done; the TypeScript
core plus Python CLI seam is decided, see `docs/d0/decisions.md`) → **D1** a
single-host spike: dispatch, inspect, steer and cancel without chat (the
current slice) → **D2** fleet and recovery → **D3** chat split → **D4**
culture-rules integration → **D5** embodiment integration → **D6** migration
and deprecation. D2 part one is built; D2 part two to D6 are not (planned).

## Code architecture (what exists today)

- **Core** — `core/src/` is ESM TypeScript, built to `core/dist/`. Modules:
  `contract/` (schema loader, validator, generated types), `daemon/` (Unix
  socket HTTP server, single-instance lock, allow-list), `store/` and
  `worker/` (on-disk run store; one detached worker process per run), `runs/`
  (orchestration: configured limits, control forwarding, restart reconciliation),
  `sandbox/` (OpenShell sandbox provider and git-bundle working-tree
  handoff), `harness/` (Claude Code driver over the Vercel AI SDK, OpenCode v2
  driver over its server API, a stub driver, the registry). `core/policy/`
  holds the sandbox policy and provider profiles, `core/image/` the run
  image. AI SDK types must not leak into the public contract. Every npm
  dependency is an exact pin, installed with `npm ci`.
- **Contract** — `contract/*.json` are JSON Schemas plus `fixtures/`; see
  `contract/README.md` for the rules the schemas cannot express. Change the
  schemas first, then regenerate (`npm run gen:contract`); never hand-copy
  shapes into either side.
- **CLI** — `culture_agents/cli/_app.py` builds the CLI on **agentfront**
  (one registry of verbs and docs, so `learn`, `explain` and `overview`
  describe exactly what is registered). Verbs live in `cli/_commands/<name>.py`
  (`agents.py`, `runs.py` are the control-plane groups); `cli/_client.py` is
  the stdlib HTTP-over-Unix-socket client of the core. The code was cited from
  teken's `python-cli` reference (cite-don't-import), so it is ours to modify.
  **Dependency rule:** `agentfront` and `jsonschema` are the approved runtime
  dependencies; any other needs the owner's approval. `teken` and `pyyaml` are
  dev-only.
- **Error/output contract** — handlers raise `CliError` (`cli/_errors.py`).
  agentfront's `App.run_cli` wraps any other exception so no traceback leaks,
  and argparse errors route through the same path. Every core response is
  validated against the contract schemas (`cli/_contract.py`); an invalid one
  is an `internal` error, exit 2. Text mode shows control characters in
  run-originated text as visible escapes (`cli/_text.py`). `cli/_output.py` writes results to
  stdout and diagnostics to stderr, never mixed. Every command supports
  `--json`. Exit codes: `0` ok, `1` user error, `2` environment error (for
  example the core is not running), `3+` reserved. `teken cli doctor .
  --strict` enforces this rubric in CI, and any new noun group must pass it.
- **`explain` catalog** — `culture_agents/explain/` holds the markdown for
  every noun/verb path (`catalog.py`, `catalog_control.py`). Give a new verb
  or noun a catalog entry so `agents explain <path>` resolves it.
- **Identity** — `whoami`/`doctor` read `culture.yaml` (`find_culture_yaml`,
  `read_agent_fields` in `cli/_commands/whoami.py`). `doctor` mirrors
  `steward doctor`'s **prompt-file-present** and **backend-consistency**
  invariants. Its `_PROMPT_FILE` table must match
  `.claude/skills/agent-config/data/backend-fingerprints.yaml`, and
  `tests/test_harness_registries.py` fails if they drift.
- **Harness smoke** — `scripts/harness-smoke.py` is the entry point. The
  stages live in `scripts/_harness_smoke/`: `config` (always runs; fails if
  any of the five harness configs is broken, e.g. a missing or empty prompt
  file, an unregistered prompt path, or a broken skills symlink), `toolchain`
  (a `guild create` dry-run per harness; OpenCode has no guild harness, so it
  is reported as SKIP), and `live` (skipped on stock runners and reported as
  NOT VERIFIED, never as a pass). The harness list and invocations come from
  `docs/harness-invocations.yaml`. Adding a harness means updating that file,
  `HARNESSES`/`HARNESS_BACKEND` in `scripts/_harness_smoke/common.py`, and
  the config stage's `SKILLS_WIRING`; the tests fail if these disagree.
- **`spikes/`** — throwaway D0/D1 probe code kept as evidence. It is never
  built, linted or held to the line cap.

## Prompt files by harness and identity

`culture.yaml` declares `suffix: culture-agents`, `backend: claude`, so
**this file is the mesh resident's prompt**. The other four harnesses are
still usable interactively over the same clone:

- **Claude Code** → `CLAUDE.md`
- **OpenCode** → `AGENTS.md`. OpenCode reads a directory's `AGENTS.md` in
  preference to its `CLAUDE.md` and falls back to `CLAUDE.md` only when
  `AGENTS.md` is absent. It discovers `.claude/skills` natively.
- **Pi / associate** → `AGENTS.override.md` (context) + `.pi/SYSTEM.md`
  (replaces Pi's system prompt with the read-only `associate` identity).
  `AGENTS.override.md` also keeps Pi from loading `AGENTS.md` or `CLAUDE.md`.
- **colleague** → `AGENTS.md` → `AGENTS.colleague.md` (its cascade)
- **Qwen Code** → `QWEN.md` + `AGENTS.md`

Because colleague and Qwen Code also load `AGENTS.md`, keep it
harness-neutral project context. Put OpenCode-only or Claude-only instructions
in that harness's own file. OpenCode rides the `acp` backend, under which the
fingerprint registry already lists `AGENTS.md`.

`.qwen/skills`, `.colleague/skills` and `.pi/skills` are symlinks onto
`.claude/skills`. "Which harness I run" and "which backend `culture.yaml`
declares" are two separate selections (`docs/harness-selection.md`). Forcing
a harness for automation is invocation-level only and must never rewrite
`culture.yaml` (`docs/automation-contract.md`). When you change what this repo
is or how it works, update all five prompt files so they don't drift.

## Conventions

- **Every PR bumps the version**, even docs/config/CI changes. Use the
  `version-bump` skill; CI's `version-check` job blocks merge otherwise.
- **PRs** go through the `cicd` skill (`devex pr` + SonarCloud gating). It
  signs posts as `- culture-agents (Claude)` automatically. Prerequisites on
  PATH: `devex` (cicd), `agtag` (communicate), and optionally `colleague`
  (ask-colleague).
- **File length** — every tracked Python and TypeScript file stays at or
  under **400 lines** (`scripts/check-file-length.py`, `MAX_LINES`; vendored
  skills and `spikes/` are exempt). Split into focused modules before crossing the cap;
  `scripts/_harness_smoke/` is the worked example.
- **Vendored skills** under `.claude/skills/` are cited verbatim from
  guildmaster (devague-origin and colleague-origin skills are noted in
  `docs/skill-sources.md`). Never edit their scripts; re-sync upstream.
- **Reach for `ask-colleague` reflexively.** Run `review` before presenting
  or opening a PR on a non-trivial diff, and `explore` for a fresh read of an
  unfamiliar area. Both are read-only, in throwaway worktrees. `write
  --apply` / `--pr` needs the user's go-ahead. Treat the output as a second
  opinion to verify, never as authority.
- **Cross-repo work** (culture-chat, culture-rules, embodiment, cultureagent,
  agent-lifecycle) goes through the `communicate` skill as tracked issues on
  the sibling repo, not edits made from here.
- **Dependencies** — Python runtime: only `agentfront` and `jsonschema`;
  anything else needs the owner's approval. npm: every dependency in `core/package.json` is an
  exact pin (no `^` or `~`), changed together with `package-lock.json`.
- **Secrets** — `scripts/scan-secrets.py` scans every tracked file (TypeScript
  included; lockfiles are excluded). Nothing credential-shaped or
  non-localhost goes in tracked files.
- **Deploy**: a push to `main` publishes npm with provenance, then PyPI via
  Trusted Publishing (`.github/workflows/publish.yml`). `core/package.json`
  carries the same version as `pyproject.toml`; the workflow fails when they
  differ. PRs do an npm dry-run; same-repo PRs also stage a development
  version on npm (`<version>-dev.<run>.<attempt>`, tag `dev`, not publicly
  installable, removed only by the owner with 2FA) and publish a dev build to
  TestPyPI.
- Keep docs grounded in what is on disk. Mark anything ahead of reality
  `(planned)`.

## Worktrees

Worktrees you create live in `../.worktrees.culture-agents/<name>/`, never in
a shared `../worktrees/`:

```bash
git worktree add ../.worktrees.culture-agents/<name> -b <scoped-prefix>/<name>
```

Use a work-scoped branch prefix (`runs/d1-spike`, not `agent/t2`). The
vendored `assign-to-workforce` skill's example uses `../worktrees/` and
`agent/<id>`; override both when you follow it. `ask-colleague`'s
self-cleaning temp worktrees under `${TMPDIR:-/tmp}` are exempt. Clean up with
`git worktree remove <path>`, and never `rm -rf` a worktree you didn't create.

## Memory (eidetic)

`/recall` before non-trivial work. `/remember` non-obvious decisions,
constraints and gotchas as they surface. Don't store what the repo or git
history already records. The wrappers default to this agent's **private**
`culture-agents` scope under `$HOME/.eidetic/memory`, which is not committed.
Passing `--visibility public` writes to the committed in-repo store
`.eidetic/memory/`, shared with the team and mesh peers. Claude and the
colleague backend resolve the same scope, so they share records.
