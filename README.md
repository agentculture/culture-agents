# culture-agents

Control plane for AgentCulture agents: direct dispatch, sessions, and lifecycle (dispatch, attach, steer, delegate, cancel, resume, supervise) over harness adapters, independent of chat.

The CLI ships as `agents`, the Python package is `culture_agents`, and the
PyPI dist is `culture-agents`.

## Status

**Early: scaffold only.** guildmaster provisioned this repo from
`culture-agent-template`. Today it holds the agent-first CLI baseline, the mesh
identity, the harness prompt files, the vendored skill kit, and CI. The
control-plane features below are **planned** and not built yet. The plan is
tracked in:

- [#1: Founding brief](https://github.com/agentculture/culture-agents/issues/1).
  culture-agents is the agent control plane.
- [#2: Design and migration](https://github.com/agentculture/culture-agents/issues/2).
  Consolidates the agent runtime, splits out culture-chat, and keeps
  embodiment as an app on top.

## Where it fits (planned)

**Culture = workspace. culture-agents = agent control. culture-chat =
communication. culture-rules = automation.**

| Repo | Owns |
| --- | --- |
| **culture-agents** | Agent registry, direct dispatch and delegation, sessions and runs, live control (attach, steer, pause/resume, cancel, answer), supervision, harness adapters, authoritative run state |
| **culture-chat** | Rooms, threads, participants, presence, history |
| **culture-rules** | Workflow automation. It calls the culture-agents API when a workflow needs an agent. |
| **embodiment** | An independent app built on culture-agents: realtime voice, barge-in, turn-taking, sensory events |

Key principles:

- **Agents exist without chat.** An agent can run, receive work and be
  supervised without joining a room. Chat is an optional surface, and losing
  it never kills a run.
- **Agents dispatch agents directly** through the same authorized control API.
  There is no separate dispatch repo.
- **The harness layer sits behind an adapter boundary.** Vercel AI SDK 7
  `HarnessAgent` (Claude Code, Codex, OpenCode, Pi) replaces custom harness
  glue where it proves equivalent. Fleet dispatch, placement, idempotency and
  recovery stay here.
- **Consolidation:** `agent-lifecycle` (supervision) and `cultureagent`
  (harness wrappers) merge in. They are archived only after compatibility and
  recovery tests pass.

Proposed CLI surface (not yet ratified):

```text
agents agents list | status
agents runs submit | list | show | attach | steer | pause | resume | cancel | answer
agents runs logs | artifacts | result
```

Delivery runs through gates **D0** (inventory, contract, and the TypeScript
vs Python decision) to **D6** (migration and deprecation). Details are in #2.

## Quickstart

```bash
uv sync
uv run pytest -n auto                 # run the test suite
uv run agents whoami                  # identity from culture.yaml
uv run agents learn                   # self-teaching prompt (add --json)
uv run teken cli doctor . --strict    # the agent-first rubric gate CI runs
```

## CLI (today)

| Verb | What it does |
|------|--------------|
| `whoami` | Report this agent's nick, version, backend, and model from `culture.yaml`. |
| `learn` | Print a structured self-teaching prompt. |
| `explain <path>` | Markdown docs for any noun/verb path. |
| `overview` | Read-only descriptive snapshot of the agent. |
| `doctor` | Check the agent-identity invariants (prompt-file-present, backend-consistency). |
| `cli overview` | Describe the CLI surface itself. |

Every command supports `--json`. Results go to stdout and errors/diagnostics
to stderr, never mixed. Exit codes: `0` success, `1` user error, `2`
environment error, `3+` reserved. The runtime package has no third-party
dependencies. The CLI was cited from
[teken](https://github.com/agentculture/teken) (`afi-cli`).

## What the repo carries

- **A mesh identity**: `culture.yaml` (`suffix: culture-agents`,
  `backend: claude`) plus the matching resident prompt, `CLAUDE.md`.
- **Prompt files for five agent harnesses** (see below).
- **The guildmaster skill kit** under `.claude/skills/`, vendored
  cite-don't-import. See [`docs/skill-sources.md`](docs/skill-sources.md).
- **A build and deploy baseline**: pytest, lint, a per-harness smoke check,
  the agent-first rubric gate, and PyPI Trusted Publishing in GitHub Actions.

## Prompt files by harness

| Harness | File(s) |
|---------|---------|
| Claude Code | [`CLAUDE.md`](CLAUDE.md) |
| OpenCode | [`AGENTS.md`](AGENTS.md) |
| Pi / associate | [`AGENTS.override.md`](AGENTS.override.md) + [`.pi/SYSTEM.md`](.pi/SYSTEM.md) |
| colleague | [`AGENTS.md`](AGENTS.md) → [`AGENTS.colleague.md`](AGENTS.colleague.md) |
| Qwen Code | [`QWEN.md`](QWEN.md) + [`AGENTS.md`](AGENTS.md) |

`CLAUDE.md` is the fullest write-up of the repo's conventions, so read it
first.

`AGENTS.md` is OpenCode's file. OpenCode prefers it over `CLAUDE.md` and reads
`.claude/skills` natively. colleague and Qwen Code load it too, so it holds
harness-neutral project context. Pi never sees it, because
`AGENTS.override.md` replaces it for this directory.

## Two selections, not one

1. **The interactive harness** is whichever binary you run (`claude`, `pi`,
   `colleague`, `qwen`, `opencode`). All five work over the same clone at
   once. Automation
   can force one per invocation without touching `culture.yaml`; see
   [`docs/automation-contract.md`](docs/automation-contract.md).
2. **The mesh resident** is the single `backend` that `culture.yaml` declares.
   It is what the Culture daemon starts and what `steward doctor` checks.

See [`docs/harness-selection.md`](docs/harness-selection.md) for the full
writeup.

## Contributing

- Every PR bumps the version (the `version-bump` skill). CI's `version-check`
  job enforces this.
- CI fails on any tracked Python file over 400 lines
  (`scripts/check-file-length.py`).
- The vendored skills are cited verbatim. Fix them upstream in guildmaster.

## The `gate` section

`culture.yaml` carries a top-level `gate` section that declares how to set
up and test this repo. Tooling, such as a PR-fixer that re-runs the checks
before pushing, then needs no per-repo knowledge:

```yaml
gate:
  setup:
  - [uv, sync]
  test:
  - [uv, run, pytest, -n, auto]
```

`setup` and `test` are each a list of commands. Each command is an argv list
(never a shell string), run in order from the repo root. These values are
configuration only, and no tool supplies a default. Culture's loader ignores
unknown top-level keys, so the section is safe alongside `agents`.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
