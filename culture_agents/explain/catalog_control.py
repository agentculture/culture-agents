"""Explain entries for the control-plane noun groups (``agents`` and ``runs``)."""

from __future__ import annotations

_CORE = """\
## Needs the core

These verbs talk to the core daemon over its Unix socket
(`CULTURE_AGENTS_SOCKET`, else `$XDG_RUNTIME_DIR/culture-agents/core.sock`,
else `${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock`). On
connect the CLI checks the
core's API version and refuses an incompatible one (exit 2, naming both
versions). With no socket, or a refused connection, it exits 2 with a hint to
start the core. A refusal by the core (`denied`, `unsupported`, `busy`,
`conflict`, `invalid`, `not_found`) exits 1 and keeps its typed code; `--json`
errors carry it as `error_code`.
"""

_AGENTS_LIST = f"""\
# agents agents list

Lists every agent the core knows (state, harnesses, repositories, active runs)
and every harness capability document. Capabilities are reported honestly: an
unsupported one says so and why.

## Usage

    agents agents list
    agents agents list --json

{_CORE}"""

_AGENTS_STATUS = f"""\
# agents agents status <agent_id>

Shows one agent and the capability document of each harness it can use, so you
can see before dispatching whether a harness can steer or cancel.

## Usage

    agents agents status thor-culture-agents
    agents agents status thor-culture-agents --json

{_CORE}"""

_RUNS = f"""\
# agents runs

Noun group for runs, the control plane's unit of work. A run is submitted to an
agent on a harness in a repository, then observed and controlled. The core owns
run state; the CLI only asks.

- `runs submit` — start a run; returns it queued.
- `runs list` — runs, newest first.
- `runs show <run_id>` — one run.
- `runs attach <run_id>` — follow events live.
- `runs steer <run_id> <message>` — send a mid-run instruction.
- `runs cancel <run_id>` — start cancellation.
- `runs logs <run_id>` — a page of stored events.
- `runs result <run_id>` — the outcome of a finished run.

`pause`, `resume`, `answer`, session continuation, delegation and multi-host
placement are not verbs: the contract defers them and the core refuses them as
`unsupported`.

{_CORE}"""

_SUBMIT = f"""\
# agents runs submit

Submits a task. Required: `--agent`, `--harness`, `--repo`, `--task`. The task
text is data and is sent verbatim. Dispatch is deny-by-default: the core needs
an allow-list entry matching agent, harness and repo, and answers `denied`
otherwise. A repository with an active run answers `busy`.

Optional: `--deadline <UTC time>`, `--idempotency-key` (recorded, not
deduplicated: do not blindly retry), `--caller` and `--caller-kind` (default
`<node>-operator`, kind `operator`), `--session-id` and `--parent-run-id`
(the core refuses both as `unsupported`).

## Usage

    agents runs submit --agent thor-culture-agents --harness claude-code \\
        --repo /srv/repos/demo --task "Add a unit test"
    agents runs submit ... --json

{_CORE}"""

_LIST = f"""\
# agents runs list

Lists runs, newest first. Filters: `--state`, `--agent`, `--limit` (1-500,
default 50).

## Usage

    agents runs list
    agents runs list --state running --json

{_CORE}"""

_SHOW = f"""\
# agents runs show <run_id>

Shows one run: state, owner, timestamps, newest event cursor, whether live
control is available (false after a core restart), and the task.

## Usage

    agents runs show thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5 --json

{_CORE}"""

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

{_CORE}"""

_STEER = f"""\
# agents runs steer <run_id> <message>

Delivers a mid-run instruction. Accepted means delivered to the run's worker,
not that the harness obeyed. A harness that cannot steer, a run that is not
`running`, and a run whose live control was lost in a core restart are refused
(`unsupported` or `conflict`); nothing is queued or simulated.

## Usage

    agents runs steer <run_id> "Stop writing files; write STEERED.txt."

{_CORE}"""

_CANCEL = f"""\
# agents runs cancel <run_id>

Starts cancellation: the run moves to `cancelling`, then a terminal state once
the harness has stopped. `--reason` is recorded. Cancelling a run that is
already `cancelling` is accepted and has no further effect.

## Usage

    agents runs cancel <run_id> --reason "wrong repository"

{_CORE}"""

_LOGS = f"""\
# agents runs logs <run_id>

Reads a page of the run's stored events, oldest first: `--after <cursor>`
(default 0) and `--limit` (1-5000, default 500). When more events exist the
text output says so and `--json` carries `more: true` and `last_cursor`.

## Usage

    agents runs logs <run_id> --after 6 --json

{_CORE}"""

_RESULT = f"""\
# agents runs result <run_id>

Shows the outcome of a terminal run: state, branch, commits, summary, error. On
a run that is still active the core answers `conflict` (retryable); a run in
state `unknown` is never reported as succeeded.

## Usage

    agents runs result <run_id> --json

{_CORE}"""

CONTROL_ENTRIES: dict[tuple[str, ...], str] = {
    ("agents", "list"): _AGENTS_LIST,
    ("agents", "status"): _AGENTS_STATUS,
    ("runs",): _RUNS,
    ("runs", "submit"): _SUBMIT,
    ("runs", "list"): _LIST,
    ("runs", "show"): _SHOW,
    ("runs", "attach"): _ATTACH,
    ("runs", "steer"): _STEER,
    ("runs", "cancel"): _CANCEL,
    ("runs", "logs"): _LOGS,
    ("runs", "result"): _RESULT,
}
