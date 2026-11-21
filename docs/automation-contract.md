# Forced-invocation automation contract

This page documents the **invocation-level** contract for force-selecting a
harness in a clone of `culture-agents`, and is the human-readable
face of [`docs/harness-invocations.yaml`](harness-invocations.yaml) — the
machine-readable source both this page and the CI smoke check (t12) read.
Edit the YAML file; this page describes it, it does not duplicate its data.

## The two selections (context, not re-derived here)

There are two separate selections over one clone:

1. **The interactive harness** — chosen by which binary you run. `cd` into
   the clone and run `claude`, `pi`, `colleague`, `qwen`, or `opencode`. All five are
   live simultaneously against the same working tree; there is no switch to
   flip and no file to edit.
2. **The mesh resident** — the single backend `culture.yaml` declares, which
   is what the Culture daemon starts.

Any harness can be **force-chosen** — by a human, or by automation such as a
CI smoke check — regardless of what `culture.yaml` says. Because a shared
checkout may have other callers running concurrently, forcing a harness
**must be invocation-level**: passing flags to that one process, never
rewriting `culture.yaml` or any other tracked file. A config-mutating force
would race other callers and leave the working tree dirty for whoever runs
next.

## The contract

For each harness: the exact binary + flags that (a) run one non-interactive
turn and (b) resolve *this clone's* config file(s), with no working-tree
side effects.

| Harness | Binary + args | Resolves | Read-only |
|---|---|---|---|
| claude | `claude -p "…"` | `CLAUDE.md` | yes |
| pi | `pi -p --approve --no-tools "…"` | `AGENTS.override.md`, `.pi/SYSTEM.md` | yes |
| qwen | `qwen --approval-mode plan --output-format text "…"` | `QWEN.md` | yes |
| colleague | `colleague agents list` | `AGENTS.colleague.md` | yes |
| opencode | `opencode run --agent plan --archived "…"` | `AGENTS.md` | yes |

The literal argv (including the exact probe prompts) lives in
[`harness-invocations.yaml`](harness-invocations.yaml) under
`harnesses.<name>.{binary,args}`. Criterion 2 of this contract — "the
documented invocations are the same commands the smoke check runs" — is
satisfied by construction: both this page and the future CI job are meant to
read that one file rather than each hand-copying the command.

### claude

```sh
claude -p "Answer with exactly one word, yes or no: does CLAUDE.md describe this project as culture-agents?"
```

`-p`/`--print` runs a single non-interactive turn and exits — no
interactive session lingers to hang a script. CLAUDE.md auto-discovery is
claude's default behavior in a directory that ships `CLAUDE.md`; nothing
opts it in (only `--bare` opts back out, and this invocation does not pass
`--bare`).

### pi

```sh
pi -p --approve --no-tools "Answer with exactly one word, yes or no: does your system prompt say your role mirrors the associate role defined in lobes-cli?"
```

Two flags matter here beyond `-p` (non-interactive):

- **`--approve`** is required, not optional. Per the Pi README ("Context
  Files" / "Project Trust" sections, shipped inside the installed
  `@earendil-works/pi-coding-agent` package):
  Pi's context files (here, `AGENTS.override.md`, which replaces
  `AGENTS.md`/`CLAUDE.md` for this directory) load unconditionally, but its
  project-local `.pi/` resources — including `.pi/SYSTEM.md`, the file that
  actually replaces Pi's default system prompt with this repo's `associate`
  identity — are gated by **project trust**. Non-interactive runs (`-p`,
  `--mode json`, `--mode rpc`) never show a trust prompt; without a saved
  decision they fall back to `defaultProjectTrust: ask`, which **ignores**
  those project-local resources. `--approve`/`-a` overrides trust for this
  one run so `.pi/SYSTEM.md` actually loads.
- **`--no-tools`** keeps the run read-only for the smoke check (`.pi/SYSTEM.md`
  itself also forbids repository writes for this role, but the flag makes
  that a property of the invocation, not just the prompt).

Why the probe asks about `lobes-cli` specifically: `AGENTS.override.md` (the
context file, which loads with or without `--approve`) already names
"associate" and ".pi/SYSTEM.md" in its own prose, so a probe like "what is
your role name" is not decisive — it returned "associate" both with and
without `--approve` in testing. The `lobes-cli` attribution
("this mirrors the `associate` role as defined in lobes-cli") appears **only**
in `.pi/SYSTEM.md`, never in `AGENTS.override.md`, so it isolates the
trust-gated file specifically.

### qwen

```sh
qwen --approval-mode plan --output-format text "Answer with exactly one word, yes or no: does QWEN.md describe this project as culture-agents?"
```

A bare positional prompt runs one-shot and exits by default (`-p`/`--prompt`
is deprecated and unnecessary). `--approval-mode plan` keeps the run
analyze-only — no file edits or shell commands are ever approved.
`--output-format text` avoids qwen's default TUI framing so a CI job can
match stdout directly. `QWEN.md` discovery is automatic in a directory that
ships `QWEN.md`; no flag opts it in.

### colleague

```sh
colleague agents list
```

Unlike the model probes, this is deliberately **not** a chat turn. `colleague
agents list` is a read-only CLI introspection command — "List resolved
AGENTS instruction layers" — that prints which `AGENTS*.md` file colleague's
prompt cascade resolves for this clone, with no model call and no
tool-use loop to sandbox. It is the cheapest and most direct proof of
resolution: it printed exactly

```text
colleague    AGENTS.colleague.md
```

(a tab-separated `name`/`file` pair; rendered here with spaces for
Markdown lint compliance)

confirming `AGENTS.colleague.md` is what colleague loads here. Since
`AGENTS.md` was added for OpenCode (2026-11-21), the same command prints the
full cascade:

```text
base         AGENTS.md
colleague    AGENTS.colleague.md
```

The check still asserts on `AGENTS.colleague.md`, the colleague-specific
layer. `AGENTS.md` is OpenCode's file, registered under the `acp` backend, so
it is not listed in colleague's `resolves`.

### opencode

```sh
opencode run --agent plan --archived "Your instructions include a project file whose top heading is either '# AGENTS.md' or '# CLAUDE.md'. Reply with only that file name (AGENTS.md or CLAUDE.md), nothing else. Do not use tools."
```

`opencode run` takes one non-interactive turn and exits. `--agent plan`
selects OpenCode's built-in read-only planning agent, and `--archived` keeps
the scripted session out of session lists. OpenCode reads a directory's
`AGENTS.md` in preference to its `CLAUDE.md`, and falls back to `CLAUDE.md`
only when `AGENTS.md` is absent. Both files open with their own name as the
top heading, so the expected answer is `AGENTS.md`.

A yes/no probe was tried first and rejected: it answered `Yes` both with
`AGENTS.md` present and with it moved aside, so it proved nothing. See the
verification below for the file-name probe's evidence, which is weaker than
the other harnesses'.

## Empirical verification (criterion 1)

Each invocation above was run in a clean checkout of this template on
2026-09-06, followed immediately by `git status --porcelain`.
In every run the only line reported was the pre-existing untracked
`docs/harness-invocations.yaml` this task itself added — never a change to
`culture.yaml` or any other tracked file, and never any file the invocation
itself produced.

| Invocation | Answer | `git status --porcelain` after |
|---|---|---|
| `claude -p "…culture-agents?"` | `Yes` | `?? docs/harness-invocations.yaml` (pre-existing; otherwise empty) |
| `pi -p --approve --no-tools "…lobes-cli?"` | `yes` | `?? docs/harness-invocations.yaml` (pre-existing; otherwise empty) |
| `qwen --approval-mode plan --output-format text "…culture-agents?"` | `yes` | `?? docs/harness-invocations.yaml` (pre-existing; otherwise empty) |
| `colleague agents list` | `colleague AGENTS.colleague.md` (tab-separated) | `?? docs/harness-invocations.yaml` (pre-existing; otherwise empty) |

The pi trust-gating claim was verified as a genuine before/after contrast,
not asserted from documentation alone:

OpenCode was added later and verified on 2026-11-21 with opencode v2.3.2:

| Invocation | `AGENTS.md` | Answers | Tree after |
|---|---|---|---|
| `opencode run --agent plan --archived "…file name…"` | present | `AGENTS.md`, `AGENTS.md` | unchanged |
| same | moved aside (negative control) | `AGENTS.md`, `CLAUDE.md` | restored, unchanged |

The negative control does **not** cleanly discriminate on the verifying host.
That host also loads a global `~/.config/opencode/AGENTS.md`, which is itself
an AGENTS.md file and confounds the question. Treat the opencode live result
as weaker evidence than the other four until it is re-run on a host without a
global OpenCode instructions file.

| Invocation | Answer | Reads |
|---|---|---|
| `pi -p --no-approve --no-tools "…lobes-cli?"` | `UNKNOWN`, or an unresolved "let me check for the system prompt file" reply (never an affirmative "yes") | `.pi/SYSTEM.md` **not** loaded |
| `pi -p --approve --no-tools "…lobes-cli?"` | `yes` (repeated) | `.pi/SYSTEM.md` loaded |

Both left `git status --porcelain` unchanged from baseline as well.

## What this does not cover

- **No harness here mutates `culture.yaml` or any other tracked file as part
  of config resolution.** All five invocations above are read/answer-only;
  none was observed to write anything. This page does not certify that
  *every* possible flag combination for these binaries is non-mutating —
  only that the five documented invocations are.
- `colleague work` (colleague's actual autonomous work loop, as opposed to
  `colleague agents list`) was not exercised here — it commits to a work
  branch, requires a reachable backend engine, and is a different order of
  operation from the lightweight, read-only smoke check this contract
  needs. If a future task wants to smoke-test colleague's config resolution
  under `colleague work` specifically, that is a new invocation, not this
  one.
- This page does not itself invoke `devague` and does not depend on it.
