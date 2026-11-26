"""Markdown catalog for ``agents explain <path>``.

Each entry is verbatim markdown. Keys are command-path tuples. The empty tuple
and ``("agents",)`` both resolve to the root entry.

Keep bodies self-contained: an agent reading one entry should get enough
context without chaining reads.
"""

from __future__ import annotations

from culture_agents.explain.catalog_branches import BRANCH_ENTRIES
from culture_agents.explain.catalog_control import CONTROL_ENTRIES

_ROOT = """\
# agents

`agents` is the CLI of culture-agents, the control plane for AgentCulture
agents: direct dispatch, persistent runs, and lifecycle control (submit,
attach, steer, cancel) over harness adapters, independent of chat. It talks
to the core daemon over a local Unix socket (`CULTURE_AGENTS_SOCKET`, else
`$XDG_RUNTIME_DIR/culture-agents/core.sock`). With the core not running every
`agents` and `runs` verb exits 2 with a hint to start it.

The CLI is built on agentfront: one registry of verbs and docs, so `learn`,
`explain` and `overview` always describe exactly what is registered.

## Verbs

- `agents whoami` — identity probe from `culture.yaml`.
- `agents learn` — structured self-teaching prompt.
- `agents explain <path>` — markdown docs for any noun/verb.
- `agents overview` — descriptive snapshot of the agent.
- `agents doctor` — check the agent-identity invariants.
- `agents cli overview` — describe the CLI surface.
- `agents agents list|status` — the agents the core knows and their harnesses.
- `agents runs submit|list|show|attach|steer|cancel|answer|logs|result` — runs.
- `agents branches list|remove` — the runs branches of a repository.

`agents explain agents` is this root page. For the `agents agents` noun group
use `agents explain agents list` and `agents explain agents status`.

## Exit-code policy

- `0` success
- `1` user-input error, including a request the core refuses (`denied`,
  `unsupported`, `limit_reached`, `conflict`, `invalid`, `not_found`)
- `2` environment / setup error (core not running, incompatible API version,
  core failure)
- `3+` reserved

## See also

- `agents explain runs`
- `agents explain whoami`
- `agents explain doctor`
"""

_WHOAMI = """\
# agents whoami

Reports the agent's identity from `culture.yaml`: nick (`suffix`), backend,
served model, and the package version. Read-only.

## Usage

    agents whoami
    agents whoami --json
"""

_LEARN = """\
# agents learn

Prints a structured self-teaching prompt covering purpose, command map,
exit-code policy, `--json` support, and the `explain` pointer. The docs and
the command list come from the registry. `--json` gives `name`, `version`,
`purpose`, `docs`, `tools`, `sections`, `exit_codes`, `json_support` and
`explain`.

## Usage

    agents learn
    agents learn --json
"""

_EXPLAIN = """\
# agents explain <path>

Prints markdown documentation for any noun/verb path. Unlike `--help` (terse,
positional), `explain` is global and addressable by path.

## Usage

    agents explain agents
    agents explain whoami
    agents explain --json <path>
"""

_OVERVIEW = """\
# agents overview

Read-only descriptive snapshot of the agent: identity (from `culture.yaml`), the
verb surface (generated from the registry), and the artifacts that make up the
repo. Accepts an ignored `target` so a stray path never hard-fails.

## Usage

    agents overview
    agents overview --json
"""

_DOCTOR = """\
# agents doctor

Checks the agent-identity invariants `steward doctor` verifies:
prompt-file-present and backend-consistency (`claude` → `CLAUDE.md`), plus a
skills-present check. Exits 1 when unhealthy.

prompt-file-present requires the *resident* prompt the declared backend
actually reads. Other harness prompt files recognized under the same backend
name (`AGENTS.override.md`, `.pi/SYSTEM.md`, `QWEN.md`) belong to
interactively available harnesses the mesh daemon never loads; they are
reported by the informational harness-prompts check and never substituted.

## Usage

    agents doctor
    agents doctor --json
"""

_CLI = """\
# agents cli

Noun group for CLI-surface introspection. `cli overview` describes the CLI
itself (distinct from the global `overview`, which describes the agent).

## Usage

    agents cli overview
    agents cli overview --json
"""


ENTRIES: dict[tuple[str, ...], str] = {
    (): _ROOT,
    ("culture-agents",): _ROOT,
    ("agents",): _ROOT,
    ("whoami",): _WHOAMI,
    ("learn",): _LEARN,
    ("explain",): _EXPLAIN,
    ("overview",): _OVERVIEW,
    ("doctor",): _DOCTOR,
    ("cli",): _CLI,
    ("cli", "overview"): _CLI,
    **CONTROL_ENTRIES,
    **BRANCH_ENTRIES,
}
