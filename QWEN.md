# QWEN.md

This file provides guidance to Qwen Code when working with code in this
repository. Qwen Code's context loader reads exactly `QWEN.md` and `AGENTS.md`
in a directory; this repo deliberately ships only `QWEN.md` — there is no
`AGENTS.md` here (each harness gets its own file; see "Prompt files by
harness" below), so this file is the sole source of project guidance for a
Qwen Code session.

## What this project is

`culture-agents` is the **agent control plane** for AgentCulture: direct
dispatch, sessions and runs, and lifecycle control (dispatch, attach, steer,
delegate, cancel, resume, supervise) over harness adapters, independent of
chat. The CLI ships as `agents`, the package is `culture_agents`, and the
PyPI dist is `culture-agents`.

**Status:** scaffold only. guildmaster provisioned the repo from
`culture-agent-template`, so today it carries the agent-first CLI baseline,
the mesh identity, the harness prompt files, the vendored skill kit, and CI.
The control-plane surface is planned. See [Roadmap](#roadmap).

It is a sibling to [`guildmaster`](https://github.com/agentculture/guildmaster)
(the **skills supplier**), [`steward`](https://github.com/agentculture/steward)
(**alignment** — `steward doctor`, the sibling-pattern baseline), and
[`teken`](https://github.com/agentculture/teken) (the **afi-cli** "Agent First
Interface" scaffolder this CLI is cited from) within the Organic Development
framework.

## Prompt files by harness

This repo's root carries one prompt file per agent harness, each read by
exactly one of them — there is no shared base file for them to inherit from:

- **Claude Code** → [`CLAUDE.md`](CLAUDE.md) (the fullest write-up; read it
  first if you are new to the repo).
- **Pi / associate** → [`AGENTS.override.md`](AGENTS.override.md) for context,
  plus [`.pi/SYSTEM.md`](.pi/SYSTEM.md) for its system prompt.
- **colleague** → [`AGENTS.colleague.md`](AGENTS.colleague.md).
- **Qwen Code** → this file.

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

## Roadmap

Planned, not built. Sourced from
[#1](https://github.com/agentculture/culture-agents/issues/1) (founding brief)
and [#2](https://github.com/agentculture/culture-agents/issues/2)
(design/migration):

- **Boundaries:** culture-agents owns agent execution and direct control.
  culture-chat owns rooms and messages, culture-rules owns workflows, and
  embodiment stays an independent app built on culture-agents.
- **Agents exist without chat.** Agents dispatch other agents directly
  through this repo's control API.
- **Harness adapters:** Vercel AI SDK 7 `HarnessAgent` sits behind an adapter
  boundary and is used only where it proves equivalent on the real fleet.
- **Consolidation:** `agent-lifecycle` and `cultureagent` merge in here.
- **Proposed verbs:** `agents runs submit | list | show | attach | steer |
  pause | resume | cancel | answer | logs | artifacts | result`.
- **Gates:** D0 (contract, plus the open TypeScript-vs-Python decision)
  through D6 (migration and deprecation).

## The CLI

The CLI is cited (cite-don't-import) from teken's `python-cli` reference
(`teken cli cite`), so the runtime package has **no third-party dependencies**;
`teken` (a.k.a. `afi-cli`) is a dev dependency only. Agent-first verbs:

- `agents whoami` — identity from `culture.yaml`.
- `agents learn` — structured self-teaching prompt.
- `agents explain <path>` — markdown docs for any noun/verb.
- `agents overview` — descriptive snapshot of the agent.
- `agents doctor` — check the agent-identity invariants.
- `agents cli overview` — describe the CLI surface itself.

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
- **Tests**: `uv run pytest -n auto`. **Lint**: black, isort, flake8 (line
  length 100), bandit, markdownlint.
- **Deploy**: pushing to `main` publishes to PyPI via Trusted Publishing
  (`.github/workflows/publish.yml`); PRs do a TestPyPI dry-run.

## Layout

```text
culture_agents/   agent-first CLI (cited from teken's python-cli reference)
  cli/                    parser, error/output contract, _commands/ (verbs)
  explain/                markdown catalog for `explain`
tests/                    pytest smoke + introspection tests
.claude/skills/           vendored guildmaster skill kit (cite-don't-import)
docs/skill-sources.md     skill provenance ledger
culture.yaml              mesh identity (suffix + backend)
.github/workflows/        tests + deploy (PyPI Trusted Publishing)
```

This file describes the repository **as it exists on disk today**. When you
edit, keep claims grounded in checked-in reality; if a section drifts ahead of
reality, mark it `(planned)` or move it under a `## Roadmap` heading. For the
full set of workflow conventions (worktree layout, memory discipline,
`ask-colleague` usage), see [`CLAUDE.md`](CLAUDE.md) — those conventions apply
to work in this repo regardless of which harness is doing it.
