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
dispatch, sessions and runs, and lifecycle control (dispatch, attach, steer,
delegate, cancel, resume, supervise) over harness adapters, independent of
chat. The CLI ships as `agents` (`uv run agents whoami`).

**Status:** scaffold only. Today the repo has the agent-first CLI baseline,
the mesh identity, the harness prompt files, the vendored skill kit, and CI.
The control plane is planned in
[#1](https://github.com/agentculture/culture-agents/issues/1) and
[#2](https://github.com/agentculture/culture-agents/issues/2). If you are
delegated design work, read #2 first: it sets the product boundaries
(culture-chat, culture-rules and embodiment each own their own domain), the
D0–D6 delivery gates, and the open TypeScript-vs-Python decision. Don't
introduce a Node/TS runtime unless that decision has been made.

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
- Tests: `uv run pytest -n auto`. Every tracked Python file must stay at or
  under 400 lines (`scripts/check-file-length.py`).
