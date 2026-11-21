# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`culture-agents` is the **agent control plane** for AgentCulture: direct
dispatch, persistent sessions and runs, and lifecycle control (dispatch,
attach, steer, delegate, pause/resume, cancel, answer, supervise) over harness
adapters, **independent of chat**. The CLI ships as `agents`, the Python
package is `culture_agents`, and the PyPI dist is `culture-agents`.

**Current state (be honest about this):** the repo was provisioned by
guildmaster (`guild create`) from `culture-agent-template` and so far contains
only that scaffold — the agent-first CLI baseline (`whoami`, `learn`,
`explain`, `overview`, `doctor`, `cli overview`), the mesh identity, the
four-harness prompt files, the vendored skill kit, and CI. **None of the
control-plane surface exists yet.** Everything under
[Target architecture](#target-architecture-planned) is planned, sourced from
the founding brief
([#1](https://github.com/agentculture/culture-agents/issues/1)) and the
design/migration issue
([#2](https://github.com/agentculture/culture-agents/issues/2)). Read #2 before
designing anything; it is the authoritative plan, and its D0 decisions are
still open.

## Commands

```bash
uv sync                                   # install (runtime has zero deps; dev deps via uv)
uv run pytest -n auto                     # full suite (what culture.yaml's gate runs)
uv run pytest tests/test_cli.py -k whoami # single file / single test
bash .claude/skills/run-tests/scripts/test.sh --ci   # mimic CI: -n auto + coverage xml
uv run agents whoami                      # the CLI entry point is `agents`
uv run agents doctor --json
```

Lint — the CI `lint` job runs all of these; run them before pushing:

```bash
uv run black --check culture_agents tests
uv run isort --check-only culture_agents tests
uv run flake8 culture_agents tests
uv run bandit -c pyproject.toml -r culture_agents
markdownlint-cli2 "**/*.md" "#node_modules" "#.local" "#.claude/skills" "#.teken"
uv run teken cli doctor . --strict        # agent-first rubric gate
python3 scripts/scan-secrets.py           # committed secrets / non-localhost endpoints
python3 scripts/check-file-length.py      # 400-line cap per tracked Python file
uv run python scripts/harness-smoke.py --stage all --require config  # all five harness configs
```

Coverage floor is 60% (`[tool.coverage.report] fail_under`). Line length is 100
(black, isort, flake8).

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

Proposed (not ratified) CLI surface, which will register as new noun groups:

```text
agents agents list | status
agents runs submit | list | show | attach | steer | pause | resume | cancel | answer
agents runs logs | artifacts | result
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

Delivery gates (#2): **D0** inventory and contract, including the open
**TypeScript-vs-Python seam** (a TS AI-SDK harness service driven by the
Python `agents` CLI, or a TS-first core; settle it before building D1) →
**D1** a single-host spike: dispatch, inspect, steer and cancel without chat →
**D2** fleet and recovery → **D3** chat split → **D4** culture-rules
integration → **D5** embodiment integration → **D6** migration and
deprecation. Don't add an unmanaged Node runtime as a side effect of another
change; that choice is D0's to make.

## Code architecture (what exists today)

- **CLI** — `culture_agents/cli/__init__.py` builds an argparse tree. Each verb
  or noun group lives in `cli/_commands/<name>.py` and exposes
  `register(subparsers)`; new groups (e.g. `runs`) are added in
  `_build_parser()` at the marked spot. The code was cited from teken's
  `python-cli` reference (cite-don't-import), so it is ours to modify, and the
  runtime package must keep **zero third-party dependencies** (`teken` and
  `pyyaml` are dev-only).
- **Error/output contract** — handlers raise `CliError` (`cli/_errors.py`).
  `_dispatch` wraps any other exception so no traceback leaks, and argparse
  errors route through the same path via `_CliArgumentParser`. `cli/_output.py`
  writes results to stdout and diagnostics to stderr, never mixed. Every
  command supports `--json`. Exit codes: `0` ok, `1` user error, `2`
  environment error, `3+` reserved. `teken cli doctor . --strict` enforces
  this rubric in CI, and any new noun group must pass it too.
- **`explain` catalog** — `culture_agents/explain/catalog.py` holds the
  markdown for every noun/verb path. Give a new verb or noun a catalog entry
  so `agents explain <path>` resolves it.
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

### Known drift from the scaffold

`pyproject.toml` exposes the script as `agents`, but the parser still says
`prog="culture-agents"` and describes itself as "a clonable template". The
`learn`/`explain` text and `AGENTS.override.md`'s layout block still use
template wording too. Fix these when you touch the CLI, not as drive-by edits
in an unrelated PR.

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
- **File length** — every tracked Python file stays at or under **400
  lines** (`scripts/check-file-length.py`, `MAX_LINES`; vendored skills are
  exempt). Split into focused modules before crossing the cap;
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
- **Deploy**: a push to `main` publishes to PyPI via Trusted Publishing
  (`.github/workflows/publish.yml`), and PRs do a TestPyPI dry-run.
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
