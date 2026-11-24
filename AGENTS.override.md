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
dispatch, sessions and runs, and lifecycle control (dispatch, attach, steer,
delegate, cancel, resume, supervise) over harness adapters, independent of
chat. The CLI ships as `agents`, the package is `culture_agents`, and the
PyPI dist is `culture-agents`.

**Status:** scaffold only. guildmaster provisioned the repo from
`culture-agent-template`, and it currently holds the agent-first CLI
baseline, the mesh identity, the harness prompt files, the vendored skill kit,
and CI. The control-plane surface is **planned**. When asked what the repo
does, separate what exists on disk from the plan in
[#1](https://github.com/agentculture/culture-agents/issues/1) (founding brief)
and [#2](https://github.com/agentculture/culture-agents/issues/2)
(design/migration). That plan has culture-agents own agent execution and
control, culture-chat own communication, culture-rules own workflows, and
embodiment stay an independent app on top. It also merges `agent-lifecycle`
and `cultureagent` into this repo. Agents must be able to run without joining
chat.

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
culture_agents/   `agents` CLI, built on agentfront (one App registry)
  cli/                    _app.py registry, socket client, error/output contract, _commands/ (verbs)
  explain/                markdown catalog for `explain`
tests/                    pytest smoke + introspection tests
.claude/skills/           vendored guildmaster skill kit (cite-don't-import)
docs/skill-sources.md     skill provenance ledger
culture.yaml              mesh identity (suffix + backend)
.github/workflows/        tests + deploy (PyPI Trusted Publishing)
```

## Conventions worth knowing before you answer a question about this repo

- The vendored skills under `.claude/skills/` are cited **verbatim** from
  guildmaster — never propose editing their scripts; the fix belongs upstream
  (`docs/skill-sources.md` has the re-sync procedure).
- The console script and the parser `prog` are both `agents`
  (`uv run agents whoami`).
- The control-plane verbs (`agents agents list|status`, `agents runs
  submit|list|show|attach|steer|cancel|logs|result`) exist as a **client** of
  the core daemon's Unix socket. The core itself is not built yet, so against
  a stopped core they exit 2 with a hint. Don't describe runs as working
  end to end.
- Every PR bumps the version (`version-bump` skill); CI's `version-check` job
  blocks merge otherwise.
- This file describes the repo **as it exists on disk today**. If you are
  asked to update it, keep claims grounded in checked-in reality.
