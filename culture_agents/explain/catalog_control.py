"""Explain entries for the control-plane noun groups (``agents`` and ``runs``)."""

from __future__ import annotations

CORE_NOTE = """\
## Needs the core

These verbs talk to the core daemon over its Unix socket
(`CULTURE_AGENTS_SOCKET`, else `$XDG_RUNTIME_DIR/culture-agents/core.sock`,
else `${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock`). On
connect the CLI checks the
core's API version and refuses an incompatible one (exit 2, naming both
versions). With no socket, or a refused connection, it exits 2 with a hint to
start the core. A refusal by the core (`denied`, `unsupported`,
`limit_reached`, `conflict`, `invalid`, `not_found`) exits 1 and keeps its typed code; `--json`
errors carry it as `error_code`.
"""

_AGENTS_LIST = f"""\
# agents agents list

Lists every agent the core knows (state, harnesses, repositories, active runs)
and every harness capability document. Capabilities are reported honestly: an
unsupported one says so and why.

It also lists the fleet members this core heard announce themselves over the
fleet transport (`--json`: under `fleet`), and the announcements it refused
because the node name they claimed is held by another key. The list is built
from announcements only: a member that stops cleanly leaves at once, a silent
one within 16 seconds. With the fleet transport off (the default) it says so
and lists nobody. No list of hosts is kept in the repository.

## Usage

    agents agents list
    agents agents list --json

{CORE_NOTE}"""

_AGENTS_STATUS = f"""\
# agents agents status <agent_id>

Shows one agent and the capability document of each harness it can use, so you
can see before dispatching whether a harness can steer or cancel.

## Usage

    agents agents status thor-culture-agents
    agents agents status thor-culture-agents --json

{CORE_NOTE}"""

_RUNS = f"""\
# agents runs

Noun group for runs, the control plane's unit of work. A run is submitted to an
agent on a harness in a repository, then observed and controlled. The core owns
run state; the CLI only asks.

- `runs submit` — start a run; returns it queued.
- `runs list` — runs, newest first.
- `runs unreadable` — the run directories the core cannot read.
- `runs show <run_id>` — one run.
- `runs attach <run_id>` — follow events live.
- `runs steer <run_id> <message>` — send a mid-run instruction.
- `runs cancel <run_id>` — start cancellation.
- `runs answer <run_id>` — answer one pending question of a run.
- `runs logs <run_id>` — a page of stored events.
- `runs result <run_id>` — the outcome of a finished run.

`pause`, `resume`, session continuation and delegation are not verbs: the
contract defers them and the core refuses them as `unsupported`. A run on
another fleet member is `runs submit --alias`: the node of `--agent` names
the member, and nothing schedules. `answer` is a verb, but the core takes an answer to a run's
pending question only when the run's harness can ask, and otherwise refuses it
as `unsupported`.

{CORE_NOTE}"""

_SUBMIT = f"""\
# agents runs submit

Submits a task. Required: `--agent`, `--harness`, `--task`, and `--repo` (a
path on this core's host) or `--alias` (a run on another fleet member). The task
text is data and is sent verbatim. Dispatch is deny-by-default: the core needs
an allow-list entry matching agent, harness and repo, and answers `denied`
otherwise. A repository may have several active runs at once, each steered
on its own. No limit applies unless the operator configured one in the
core's config file; a submit past it answers `limit_reached`, naming the
limit and its value, and nothing is queued.

Optional: `--deadline <UTC time>`, `--idempotency-key` (default: the CLI
generates one and prints it; a repeat with the same request returns the first
run; a changed request is `conflict`; after a timeout the CLI retries with the
same key, so one run exists),
`--caller` and `--caller-kind` (default `<node>-operator`, kind `operator`),
`--session-id` and `--parent-run-id` (the core refuses both as `unsupported`).

## A run on another fleet member

`--alias <name>` sends the run, through this core and over the fleet
transport, to the member that the node of `--agent` names (the caller chooses;
nothing schedules). The repository is the alias that member defines (see
`agents agents aliases --member <node>`). The deadline is `--deadline-in
<seconds>`, a duration counted on that member's clock; an absolute
`--deadline` is refused. The base commit is the HEAD of the git checkout you
run the CLI in, unless `--base <sha>` names another or `--no-base` names none
(the run then starts from the member's HEAD); the member refuses a commit its
checkout lacks with `invalid` and fetches nothing. The response names the
commit. The run's submitter on that member is this core's member name.
`runs show`, `attach`, `steer` and `cancel` reach the member a run id names.

## Usage

    agents runs submit --agent thor-culture-agents --harness claude-code \\
        --repo /srv/repos/demo --task "Add a unit test"
    agents runs submit ... --json
    agents runs submit --agent thor-culture-agents --harness claude-code \\
        --alias culture-agents --deadline-in 3600 --task "Add a unit test"

{CORE_NOTE}"""

_LIST = f"""\
# agents runs list

Lists runs, newest first. Filters: `--state`, `--agent`, `--limit` (1-500,
default 50). When the core cannot read some run directories it skips them, and
this prints one warning line naming how many and `agents runs unreadable`;
`--json` carries that count as `unreadable_count`.

## Usage

    agents runs list
    agents runs list --state running --json

{CORE_NOTE}"""

_UNREADABLE = f"""\
# agents runs unreadable

Lists every run directory the core cannot read: its run id, why (`newer_version`,
`corrupt_record`, `unreadable_log` or `other`) and the core's message. These
runs are skipped by `runs list`; they are not absent. Listing them changes
nothing in their directories.

## Usage

    agents runs unreadable
    agents runs unreadable --json

{CORE_NOTE}"""

_SHOW = f"""\
# agents runs show <run_id>

Shows one run: state, owner, timestamps, newest event cursor, whether live
control is available (false after a core restart), and the task.

## Usage

    agents runs show thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5 --json

{CORE_NOTE}"""

_ATTACH = f"""\
# agents runs attach <run_id>

Streams a run's events: replays those after `--after` (default 0), then follows
live, and returns when the run reaches a terminal state. Text mode prints one
line per event; `--json` prints one event JSON object per line. The exit code
is 0 once the stream completes, whatever state the run ended in; use
`runs result` for the outcome.

Every event is validated against the contract and printed exactly once, in
cursor order. In text mode, control characters in harness output and other
text from the run are shown escaped (`\\x1b`, `\\n`), never sent to the
terminal; `--json` carries the exact data.

## Reconnecting

- A broken stream is reopened at once from the last cursor received, with no
  gap and no duplicate.
- If the core is gone when reopening (the connection fails, or the core
  answers `unavailable`), the reopen is retried after 0.2 s, 0.5 s, 1 s, then
  every 2 s. A core restart is survived this way. If no stream opens again
  within 30 seconds, the verb exits 2 and names the last cursor, so
  `--after <cursor>` resumes it.
- Any other error on a reopen (`not_found`, `invalid`,
  `incompatible_version`, `internal`) ends the verb at once with that error.
- A first connect that fails is not retried: exit 2 at once.
- A stream that opens and closes without an event six times in a row ends
  the verb with exit 2, unless the run is terminal with nothing left to send
  (exit 0).
- An event that breaks the contract, or a cursor that skips ahead, is a core
  fault: exit 2 (`internal`). A closed stdout (`| head -1`) ends the verb
  quietly with exit 0.

## Usage

    agents runs attach thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5
    agents runs attach <run_id> --after 12 --json

{CORE_NOTE}"""

_STEER = f"""\
# agents runs steer <run_id> <message>

Delivers a mid-run instruction. Accepted means delivered to the run's worker,
not that the harness obeyed. `--idempotency-key` is generated and printed when
omitted; after a timeout the CLI retries with the same key, so it takes effect
once. A harness that cannot steer, a run that is not
`running`, and a run whose live control was lost in a core restart are refused
(`unsupported` or `conflict`); nothing is queued or simulated.

## Usage

    agents runs steer <run_id> "Stop writing files; write STEERED.txt."

{CORE_NOTE}"""

_CANCEL = f"""\
# agents runs cancel <run_id>

Starts cancellation: the run moves to `cancelling`, then a terminal state once
the harness has stopped. `--reason` is recorded. `--idempotency-key` is
generated and printed when omitted, and retried unchanged after a timeout. Cancelling a run that is
already `cancelling` is accepted and has no further effect.

## Usage

    agents runs cancel <run_id> --reason "wrong repository"

{CORE_NOTE}"""

_ANSWER = f"""\
# agents runs answer <run_id> --question <question_id>

Answers one pending question of a run (`runs show` lists `pending_questions`).
Give `--answer <text>`, `--choice <id>[,<id>...]` or both; for an approval give
`--decision approve|deny` (`--answer` is then an optional reason). Accepted
means the answer was delivered into the run's turn.

A question takes exactly one answer. The core does not replay an answer by
`--idempotency-key`, so the CLI never retries it: a second answer to the same
question is `conflict`, as is an answer after the question's time limit or to a
run that is not `running`. A refusal is shown as its typed error in text and in
`--json` (`unsupported`, `conflict`, `not_found`, `invalid`, `unavailable`).
After `unavailable` check `runs show` before answering again.

Only the stub harness can ask today. Claude Code and OpenCode report `answer`
as unsupported, so this verb is refused with `unsupported` for their runs.

## Usage

    agents runs answer <run_id> --question <question_id> --answer "Use SQLite."
    agents runs answer <run_id> --question <question_id> --decision deny --json

{CORE_NOTE}"""

_LOGS = f"""\
# agents runs logs <run_id>

Reads a page of the run's stored events, oldest first: `--after <cursor>`
(default 0) and `--limit` (1-5000, default 500). When more events exist the
text output says so and `--json` carries `more: true` and `last_cursor`.

## Usage

    agents runs logs <run_id> --after 6 --json

{CORE_NOTE}"""

_RESULT = f"""\
# agents runs result <run_id>

Shows the outcome of a terminal run: state, branch, commits, summary, error. On
a run that is still active the core answers `conflict` (retryable); a run in
state `unknown` is never reported as succeeded.

## Usage

    agents runs result <run_id> --json

{CORE_NOTE}"""

_AGENTS_ALIASES = f"""\
# agents agents aliases --member <node>

Reads, through this core and over the fleet transport, the repository aliases
that fleet member defines, and for each the agent and harness pairs its
allow-list permits. A member names its checkouts by alias; no path crosses the
network. Use an alias with `agents runs submit --alias`. With the fleet
transport off this core answers `unsupported`; a member that does not answer
is `unavailable`.

## Usage

    agents agents aliases --member thor
    agents agents aliases --member thor --json

{CORE_NOTE}"""

CONTROL_ENTRIES: dict[tuple[str, ...], str] = {
    ("agents", "list"): _AGENTS_LIST,
    ("agents", "status"): _AGENTS_STATUS,
    ("agents", "aliases"): _AGENTS_ALIASES,
    ("runs",): _RUNS,
    ("runs", "submit"): _SUBMIT,
    ("runs", "list"): _LIST,
    ("runs", "unreadable"): _UNREADABLE,
    ("runs", "show"): _SHOW,
    ("runs", "attach"): _ATTACH,
    ("runs", "steer"): _STEER,
    ("runs", "cancel"): _CANCEL,
    ("runs", "answer"): _ANSWER,
    ("runs", "logs"): _LOGS,
    ("runs", "result"): _RESULT,
}
