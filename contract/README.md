# culture-agents control-plane contract

API version **3.0** (single source: `api.json` → `api_version`).

This directory is the contract between the TypeScript core daemon and every
client of it, starting with the Python `agents` CLI. The JSON Schemas
(draft 2020-12) fix the payload shapes. This README fixes the rules the
schemas cannot express. Both sides validate against these same files and
reuse the same fixtures. Generate types and validators from the schemas; never
copy them by hand.

Scope: one host, no chat. Version 3.0 carries the shapes of D2 part one:
recovery after a core restart, concurrent runs in one repository, idempotent
requests, operator questions, limits and admission. The shapes are fixed here.
Some of the behaviour behind them is not built yet. Every such rule below is
marked **(planned)** with the task of the D2 plan
(`docs/plans/2026-11-26-d2-fleet-and-recovery.md`) that builds it, and
[Changes from 2.0](#changes-from-20) lists them all. Until a task lands, the
core keeps its 2.0 behaviour for that rule and reports the capability as
unsupported. Everything deferred is listed in
[Deferred capabilities](#deferred-capabilities), and the contract reports it
as `unsupported`. Nothing deferred is silently missing.

Key words: **must**, **must not** and **may** are normative.

## Files

| File | Root schema | `$defs` used by routes |
| --- | --- | --- |
| `common.json` | none | identifiers, `timestamp`, `principal`, `extension` |
| `agent.json` | Agent | `agent_list` |
| `session.json` | Session | none |
| `run.json` | Run | `state`, `terminal_state`, `submitter`, `run_list`, `run_result` |
| `control-action.json` | action record | `submit_request`, `submit_response`, `warning`, `steer_request`, `cancel_request`, `pause_request`, `resume_request`, `answer_request`, `decision`, `choice_ids`, `accepted_response` |
| `event.json` | Event (log entry and stream item) | `question`, `question_data`, `answer_data`, `event_page` |
| `capabilities.json` | harness capability document | `capability_set`, `limits`, `admission`, `signal`, `capabilities_list` |
| `error.json` | error response `{"error": {...}}` | `error`, `code`, `limit`, `held_signal` |
| `version.json` | `GET /v1/version` response | none |
| `allowlist.json` | the local allow-list file (not an API payload) | none |
| `api.json` | not a schema: the index of version, transport, routes, error table and state machine | |
| `fixtures/` | example payloads, see [Fixtures](#fixtures) | |

Every `$id` is `https://culture.dev/contract/agents/<file>`. The URL is an
identifier only and is never fetched. `$ref`s are relative to it. Every object
sets `additionalProperties: false`, except the one opaque `extension` object
(see [Extension field](#extension-field-and-vendor-neutrality)).

## Transport

- HTTP/1.1 over a Unix domain socket. The path is
  `${XDG_RUNTIME_DIR}/culture-agents/core.sock`. When `XDG_RUNTIME_DIR` is
  unset, it is `${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock`
  (never a shared directory such as `/tmp`), in a directory with mode 0700. The environment variable `CULTURE_AGENTS_SOCKET` overrides both,
  for the core and the client alike.
- The socket file has mode 0600. In D1 that owner-only mode is the whole
  authentication: any process that can connect acts as the owning OS user.
- Requests and responses are `application/json` in UTF-8. The attach stream is
  `text/event-stream`.
- Clients send the header `Agents-Api-Version: <MAJOR.MINOR>` on every request.
  The core checks it when present (see [Versioning](#versioning)).
- A method or path that is not in `api.json` gets `not_found` for an unknown
  path and `invalid` for a known path with the wrong method.
- Timestamps are UTC with a `Z` suffix and come from the core host's clock.

## Identifiers

- **Mesh id**, written `<node>-<agent>`, for example `thor-culture-agents`.
  `<node>` is `[a-z0-9]{1,32}` and has no hyphen, so the first hyphen always
  ends the node. `<agent>` is the culture.yaml `suffix`. Agents and principals
  both use this form. A mesh id is at most 96 characters. The core reads
  `<node>` from the local `server.yaml` file and must reject a name that does
  not match the pattern. Reading the file needs no running chat server, and
  validating a payload needs no network.
- **Run id**, written `<node>-<agent>.run.<ULID>`. The agent part is the
  executing agent's mesh id. **Session id** is `<node>-<agent>.ses.<ULID>` and
  **action id** is `<node>-<agent>.act.<ULID>`, using the run's agent. Ids are
  assigned by the core, never by the client, and are never reused. Each is at
  most 127 characters: a mesh id, then the 31 characters of `.run.<ULID>`.
- **Question id**, written `<node>-<agent>.qst.<ULID>`, using the run's
  agent. The run's worker assigns it when it records the question. The
  harness's own id for its request is not part of the contract: callers answer
  by the question id only.
- A run's host branch is `runs/<run_id>`, at most 132 characters.
- `agent.id` must equal `<node>-<suffix>`. A run's `id` and `session_id` must
  start with its `agent_id` followed by `.`. The tests check these rules, and
  the core must keep them.

## Versioning

- `api.json` → `api_version` (`MAJOR.MINOR`) is the version of the whole
  contract: every schema, the route table, the error table and the state
  machine.
- Any change under `contract/` that changes what validates or how a route
  behaves bumps the version. Changes to descriptions or prose only do not.
  - **MINOR**: purely additive request-side changes. Examples: a new route, or
    a new optional request field. Every response and event that was valid
    before stays valid under the old schemas.
  - **MAJOR**: everything else. That includes any change to a response or event
    shape. Because objects are closed, even a new optional response field is
    MAJOR. So are a new enum value in a response, a new event kind, a new error
    code, a renamed or removed field, a tightened constraint, a changed
    transition, or a deferred capability becoming supportable.
- **Compatibility rule:** a client at `C.x` and a core at `S.y` are
  compatible exactly when `C == S` and `y >= x`.
- **On connect**, the client first calls `GET /v1/version`, which is never
  refused for version reasons. If the versions are incompatible, the client
  must stop and exit 2, naming both versions. On every other route, the core
  applies the same rule to the `Agents-Api-Version` header and answers 412
  `incompatible_version` with `client_api_version` and `server_api_version`.
  It checks the header before anything else.
- `core_version` in `/v1/version` is the core's release version. It is
  informational only and never used for compatibility.

## Changes from 2.0

Version 3.0 is one MAJOR bump that carries every contract change of D2 part
one. A 2.0 client and a 3.0 core refuse each other in both directions, with
exit 2 and a message that names both versions.

Each row is a breaking change under the rules above. "Built by" names the plan
task that makes the core produce or accept the shape. A row marked *shape
only* is in the schemas and fixtures now, and the core does not produce it
until that task lands. 3.0 is not released before those tasks: they change
behaviour inside 3.0, without another bump.

| Change | Where | Required in 3.0 | Built by |
| --- | --- | --- | --- |
| `api_version` is `3.0` | `api.json`, `GET /v1/version` | yes | this change |
| `submitter`: who submitted the run, as the core established it | Run | optional; absent on a run recorded before the core set it | t11, *shape only* |
| `base_commit`: the commit the run starts from | Run | optional; absent on a run recorded before the core set it | t7 (built) |
| `pending_questions`: questions waiting for an answer | Run | optional; must be empty on a terminal run | t13 (built): always reported, read from the log |
| `unanswered`: a new terminal state, reached from `cancelling` | Run `state`, `run_result`, the `state` query of `runs.list`, `state_machine` | part of the enum | t13 (built) |
| `limit_reached`: a new error code (HTTP 429, exit 1) with a required `limit` naming the limit, its value and the active count | error, `runs.submit` | `limit` is required with this code and forbidden with any other | t8 (built) |
| `busy` is removed, with its `active_run_id` and `repo` fields and the one-active-run-per-repository rule | error, `runs.submit` | gone: a 3.0 core never answers it | t8 (built) |
| `conflict` may carry `idempotency_key`: the key was used with a different request | error, `runs.submit`, `runs.steer`, `runs.cancel`, `runs.answer` | optional; `retryable` is then false; forbidden with any other code | t6 (built) |
| `question_id` on an error that concerns a question | error | optional | t13 (built) |
| `unavailable` may carry `retry_after_ms`: retry shortly, for a control request that arrives while the core reattaches to the run's worker | error | optional; forbidden with any other code | t9, *shape only* |
| `run.question` and `run.answer`: two new event kinds | event | each kind pins its `data` | t13 (built) |
| `run.control` records a steer or a cancel only | event | tightened: an accepted answer is a `run.answer` | this change |
| `answer_request`: `question_id` must be a question id; `answer` is optional; `choice_ids` and `decision` are new | `runs.answer` request | `caller` and `question_id` are required | t13 (core, built), t16 (CLI) |
| `runs.answer` may be accepted, and may answer `conflict` or `unavailable` | route | | t13 (built); still `unsupported` for a harness that cannot ask |
| `replayed` and `warnings` on the submit response; a replayed run need not be `queued` | `submit_response` | both optional | t6 (`replayed`, built), t17 (`warnings`, built) |
| `replayed` on the accepted action response | `accepted_response` | optional | t6 (built) |
| `runs.submit` may answer `conflict` and `limit_reached` | route | | t6 (`conflict`, built), t8 (`limit_reached`, built) |
| `answer`, `reconnect` and `worktree_isolation` may be reported as supported | capability document | `reconnect` and `worktree_isolation` are reported supported; `answer` is reported supported by the stub harness only, whose driver asks | t13 (built), t9 (built), t8 (built) |
| `limits`, `active_runs` and `admission` on the capability document | capability document | all optional | t17, built |
| `placement` may be reported as supported | capability document | every harness of this core reports it unsupported, with its reason | t30, *shape only* (planned, part two) |
| `admission_held`: a new error code (HTTP 429, exit 1, retryable) with a required `signal` naming the signal (`heat` or `gateway`), its `state` (`hold` or `unknown`) and `observed_at` | error, `runs.submit` | `signal` is required with this code and forbidden with any other; no route returns it yet | t30, *shape only* (planned, part two) |

`busy` is removed in 3.0 (t8, built): the error code, its `active_run_id` and `repo` fields and the one-active-run-per-repository rule are gone from the schemas, this file and the CLI. Two or more runs may be active in one repository; no limit applies unless the operator configures one, and a submit past a configured limit gets `limit_reached`.

Rules that change with these shapes, each when its task lands:

- An idempotency key is compared, not only recorded (t6, built). See
  [Idempotency keys](#idempotency-keys).
- A run's deadline stops advancing while one of its questions is pending
  (t13, built). See [Deadlines](#deadlines).
- A run that survived a core restart gets live control back (t9). See
  [After a core restart](#after-a-core-restart).

No D1 guarantee is weakened. No schema, fixture or generated type names a
harness-runtime, sandbox-runtime or vendor-SDK type. A refused capability is
still an `unsupported` error that names it. The cursor is still per run,
gapless and never reset. A terminal state is still final. `unknown` is still
never reported as a success, and neither is `unanswered`.

**Part two is not in 3.0.** Its own shapes come with their tasks as 3.x MINOR
additions: the list of fleet members, the unreachable view of a run on a host
that does not answer, and fetching a run's commits as a git bundle. A MINOR
addition is a new route with its own response shape, or a new optional request
field. It must not add a field, an enum value or an event kind to a shape that
exists in 3.0. Three part-two shapes that would be MAJOR later are in 3.0
already: the `submitter` kind `member`; `placement`, which the schema lets a
harness report as supported (t30); and `admission_held`, the typed refusal of a
submit that an admission signal holds, naming the signal, its state and the
time it was observed (t30). They are shapes only: every harness of this core
reports `placement` unsupported, and no route returns `admission_held`, until
part two builds them **(planned, part two)**. Part two can then add both as
behaviour inside 3.0, without a MAJOR bump.

## Routes

The authoritative list is `api.json` → `routes`, which gives each route's
method, path, request and response schema, success status, query parameters,
possible errors and CLI verb.

| Route id | Method and path | Success | CLI |
| --- | --- | --- | --- |
| `version` | `GET /v1/version` | 200 `version.json` | every verb, on connect |
| `agents.list` | `GET /v1/agents` | 200 `agent_list` | `agents agents list` |
| `agents.status` | `GET /v1/agents/{agent_id}` | 200 `agent.json` | `agents agents status` |
| `harnesses.list` | `GET /v1/harnesses` | 200 `capabilities_list` | `agents agents list` |
| `harnesses.show` | `GET /v1/harnesses/{harness}` | 200 `capabilities.json` | `agents agents status` |
| `runs.submit` | `POST /v1/runs` | 201 `submit_response` | `agents runs submit` |
| `runs.list` | `GET /v1/runs?state=&agent_id=&limit=` | 200 `run_list` | `agents runs list` |
| `runs.show` | `GET /v1/runs/{run_id}` | 200 `run.json` | `agents runs show` |
| `runs.attach` | `GET /v1/runs/{run_id}/attach?after=` | 200 SSE of `event.json` | `agents runs attach` |
| `runs.logs` | `GET /v1/runs/{run_id}/events?after=&limit=` | 200 `event_page` | `agents runs logs` |
| `runs.result` | `GET /v1/runs/{run_id}/result` | 200 `run_result` | `agents runs result` |
| `runs.steer` | `POST /v1/runs/{run_id}/steer` | 202 `accepted_response` | `agents runs steer` |
| `runs.cancel` | `POST /v1/runs/{run_id}/cancel` | 202 `accepted_response` | `agents runs cancel` |
| `runs.answer` | `POST /v1/runs/{run_id}/answer` | 202 `accepted_response` | `agents runs answer` |
| `runs.pause`, `runs.resume` | `POST /v1/runs/{run_id}/<verb>` | never: always `unsupported` | none |

Notes:

- A path parameter that does not match its pattern gets `invalid`, with the
  parameter name in `field`. A well-formed id that the core does not know gets
  `not_found`.
- `runs.list` returns runs newest first by `created_at`. `limit` defaults to
  50, with a maximum of 500. D1 has no pagination cursor.
- `runs.result` works only for a terminal run. For an active run it returns
  `conflict` with `retryable: true`.
- `agents.list` includes every harness capability document, so one call can
  serve `agents agents list --json`.
- `runs.answer` is refused as `unsupported`, capability `answer`, for a run
  whose harness cannot ask: today Claude Code and OpenCode, whose drivers do
  not raise questions yet. It is accepted for a harness that can (built, t13):
  today the stub harness.

### Order of checks

The core evaluates the checks in this order and returns the first failure.
Clients and tests may rely on the order.

`runs.submit`:

1. The `Agents-Api-Version` header → `incompatible_version`.
2. The body against `submit_request`, and `deadline` later than the core's
   clock → `invalid`.
3. The allow-list: an entry must match `agent_id`, `harness` and canonical
   `repo` exactly → `denied`.
4. The harness is known to the core → `not_found`. The harness is `available`
   → `unavailable`.
5. Capabilities, in this order. An `agent_id` whose node is not the core's
   node → `unsupported`, `placement`. A `session_id` is present →
   `unsupported`, `continue_session`. A `parent_run_id` is present →
   `unsupported`, `delegate`.
6. An `idempotency_key` that the core has on record. The same request → 201
   with `replayed: true` and the first run as it is now; nothing is created
   and the limit check is skipped. A different request → `conflict` with
   `idempotency_key` and the `run_id` the key belongs to. A key whose first
   submit is still being established → `unavailable` with `retry_after_ms`.
7. A limit the operator configured has no room → `limit_reached` with
   `limit` (built, t8). `runs_per_repository` is checked before
   `runs_per_host`. With no limit configured nothing is checked and no submit
   is refused here. Nothing is queued. See
   [Limits, load and admission](#limits-load-and-admission).
   **(planned, part two)** After the limits, a consulted admission signal
   that says `hold`, or that is `unknown` for a submit from another host →
   `admission_held` with `signal`. Today no submit is refused here.
8. The core writes the key (when there is one), then creates the session and
   run directory, then starts the worker. The worker writes its PID, its
   event log with event 1 (`run.state`, `null` → `queued`) and its cursor to
   disk. Only after that does the core answer 201 with the run in state
   `queued`.

One more check is part of `runs.submit` between steps 5 and 8:

- The repository's commit to start from cannot be resolved (built, t7) → an `invalid`
  refusal with `field: repo` at submit, not a failed run later. On success the commit is the
  run's `base_commit`.

Run-scoped control routes (`steer`, `cancel`, `pause`, `resume`, `answer`):

1. The version header → `incompatible_version`.
2. The path `run_id` format → `invalid`. The run exists → `not_found`.
3. The body against the route's request schema → `invalid`.
4. A deferred action (`pause`, `resume`) → `unsupported`, naming that
   capability.
5. The run's harness capability document does not support the action (`steer`,
   `cancel` or `answer`) → `unsupported`, naming it.
6. The state allows the action → `conflict`. `steer` needs `running`.
   `cancel` needs `queued`, `running` or `cancelling`.
7. `live_control` is false (the core restarted) → `unsupported`, capability
   `reconnect`.
8. The core cannot deliver the action to the worker → `unavailable`.
9. Accepted: 202 with the action record.

"Accepted" means the action was delivered to the run's worker. It does not
promise any effect on the harness's behaviour. A `cancel` on a run that is
already `cancelling` is accepted and recorded, but has no further effect.

`conflict` uses `retryable: true` when a later state could accept the action:
`steer` on `queued`, or `result` on an active run. Otherwise it uses `false`.

**(planned)** What changes in this order:

- Built (t13): `answer` left step 4. It is checked like `steer`: capability at
  step 5, state at step 6. It needs a `running` run and a pending question
  with that `question_id`. A question id the run never asked → `not_found`
  with `question_id`. A question that already has its answer, or whose time
  limit has passed → `conflict` with `question_id`, not retryable. An answer
  that does not fit the question → `invalid`.
- Step 7 (t9). The core reattaches to surviving workers, so `live_control`
  is true again and the refusal naming `reconnect` ends. A control request
  that arrives before the run's reattach attempt has finished waits for it or
  gets `unavailable` with `retry_after_ms` and the `run_id`. It never gets
  "live control unavailable".
- Built (t6): a repeated `idempotency_key` on `steer` or `cancel` is checked
  before step 5 → 202 with `replayed: true` and the first action record;
  nothing is delivered again, whatever the run's state is now. The same key
  with a different request → `conflict` with `idempotency_key`.

Refusals at steps 4 to 6 against a non-terminal run whose worker the core
controls are also appended to the run's event log as `run.refused` events.
Refusals at any other step are returned to the caller only.

## Run state machine

`api.json` → `state_machine` holds the machine-readable form.

| From | Allowed next states |
| --- | --- |
| (none) | `queued` |
| `queued` | `running`, `cancelling`, `failed`, `unknown` |
| `running` | `cancelling`, `succeeded`, `failed`, `unknown` |
| `cancelling` | `cancelled`, `timed_out`, `unanswered`, `succeeded`, `failed`, `unknown` |
| `succeeded`, `failed`, `cancelled`, `timed_out`, `unanswered`, `unknown` | none (terminal) |

- **Active** states are `queued`, `running` and `cancelling`. **Terminal**
  states are `succeeded`, `failed`, `cancelled`, `timed_out`, `unanswered` and
  `unknown`.
  A terminal state is final. No event follows it, and nothing changes it
  later.
- `queued`: accepted and the worker exists, but the harness session has not
  started. `running`: the harness session started (`started_at` is set).
  `cancelling`: a stop was initiated by a cancel or by the deadline. The run
  waits for the harness to stop.
- `succeeded`: the harness reported that its turn completed. `failed`: a
  failure was established, either a harness error, a sandbox that did not
  start, or a worker-recorded failure. A `run.error` with `fatal: true`
  precedes it.
- `cancelled`: it ended after an operator cancel. `timed_out`: it ended after
  its deadline. Both are reached only through `cancelling`. If the harness
  completes its turn before the stop takes effect, the run ends `succeeded`
  or `failed` as reported.
- `unanswered`: it ended because a question it asked its operator passed
  that question's own time limit. Like `timed_out`, it is reached only through
  `cancelling`, here with reason `question_limit`. It is not a success and
  not a plain `timed_out`. The run's worker writes it (built, t13).
- A run moves to `cancelled`, `timed_out` or `unanswered` according to what
  first moved it into `cancelling`. A later deadline does not turn a cancel
  into `timed_out`.
- A run that waits for an answer stays `running`. There is no waiting state:
  `pending_questions` on the run says what it waits for.
- `run.terminal` is true exactly in terminal states, and then `ended_at` is
  set and `live_control` is false.
- The state of a run is derived **only** from its on-disk event log or its
  live worker. The core must never infer a state any other way.

### `unknown`

`unknown` means that the outcome cannot be established: no live worker exists
and the event log has no terminal event. One example is a worker that died
with its harness mid-turn. Side effects of such a run may or may not have
happened. `unknown` is terminal and is **never** reported as `succeeded`.
When the core finds a run in this condition, the worker is gone and the core
is the log's only writer. It appends `run.state` → `unknown` with a reason,
at the next cursor. A worker that is alive is never reported as `unknown`.

### After a core restart

Workers are separate processes and are never terminated by a core restart.
After a restart, the core rebuilds every run from disk:

- A run with a terminal event reports that state.
- A run without a terminal event whose worker is alive is reported in the
  state its log shows, with `live_control: false`. `steer` and `cancel` are
  refused with `unsupported`, capability `reconnect`, because D1 cannot
  reattach to a surviving worker. `attach` and `logs` still work, because the
  core tails the on-disk log, which the worker keeps appending to. The deadline
  still applies, because the worker enforces it.
- A run without a terminal event and with no live worker becomes `unknown`.
- The core checks that a worker is alive by its recorded PID together with an
  identity check, so that a reused PID is not mistaken for the worker.

**(planned, t9)** The core reattaches to each surviving worker over the
worker's own control socket and reports `live_control: true` again. `steer`,
`cancel` and `attach` then work as before the restart. A worker whose control
socket does not answer is never reattached by guess and never signalled: its
run keeps the state its log shows with `live_control: false`, control requests
get `unavailable` with `retry_after_ms`, and the core tries to reattach again on
the next control request and on a bounded backoff while the worker is alive. A
control request that arrives before the reattach
attempt for its run has finished waits or gets `unavailable` with
`retry_after_ms`. Controls of terminal runs are not rebuilt.

## Events, cursor and replay

- Each run has one append-only event log. Every entry validates against
  `event.json` and has the same shape whether it is read from disk, replayed
  or streamed live.
- **Cursor:** the first event of a run has cursor 1, and every next event is
  exactly one higher. There are no gaps or duplicates, and the cursor never
  resets. The cursor belongs to the log, not to the transport, so it means
  the same thing over SSE, the logs route, or a file read. `run.cursor` is the
  newest cursor.
- Event 1 is always `run.state` from `null` to `queued`. Each `run.state` has
  `from` equal to the previous state and makes a legal transition. Nothing
  follows the terminal `run.state`.
- Event kinds in this API version:
  - `run.state`: a state transition.
  - `run.output`: normalized harness output. `channel` is `text`,
    `reasoning`, `tool_call`, `tool_result` or `diagnostic`. `text` is a
    delta, never cumulative.
  - `run.control`: an accepted `steer` or `cancel`.
  - `run.refused`: a refused control action, with `unsupported` (a capability
    refusal) or `conflict`.
  - `run.question`: the run asked its operator a question and now waits. It
    is appended before the run starts waiting. (built, t13)
  - `run.answer`: an answer was accepted and delivered into the run. It names
    a question that was pending, and a question gets at most one.
    (built, t13)
  - `run.error`: an error. When `fatal` is true, a `run.state` to `failed` or
    `unknown` follows.
- **Attach** (`GET .../attach?after=N`, where `N` is an integer of 0 or more,
  default 0):
  - If `N` is greater than the run's current cursor, the core answers
    `invalid` with `field: "after"`. Cursors are never skipped, so a client
    cannot legitimately hold one.
  - Otherwise the core answers 200 and sends every event with cursor greater
    than `N` in ascending order. It then follows live events as they are
    appended, with no gap and no duplicate between replay and live.
  - The core closes the stream right after it sends the terminal `run.state`
    event. If the run is already terminal and `N` equals its cursor, the
    stream closes at once with no events.
  - SSE framing is one event per message: `id: <cursor>`, `event: <kind>`,
    and `data: <the event JSON on one line>`, followed by a blank line. While
    the stream is idle, the core sends a comment line `: keepalive` at least
    every 15 seconds.
  - If `after` is absent, the core uses the `Last-Event-ID` header. If both
    are absent, it uses 0. A `Last-Event-ID` that is not an integer of 0 or
    more gets `invalid` with `field: "Last-Event-ID"`. It is never read as 0.
    To reconnect, a client attaches again with `after` set to the last cursor
    it received.
  - Errors that happen before the stream starts are ordinary JSON error
    responses. If the stream breaks after it starts, the client reconnects.
- **Logs** (`GET .../events?after=N&limit=M`): returns events with cursor
  greater than `N`, ascending, at most `M` of them (default 500, maximum
  5000). `last_cursor` is the run's cursor at read time. `more` is true when
  events past the last one returned exist. The same `after` bound as attach
  applies.

## Idempotency keys

`submit_request` and every control request accept an optional
`idempotency_key`. It appears on the run (`idempotency_key`) or on the action
record, exactly as sent.

Deduplication is built (t6) for `runs.submit`, `runs.steer` and
`runs.cancel`:

- A repeat of a key with the same request takes effect once. The response has
  the same status as the first one and `replayed: true`. For a submit, `run`
  is the first run as it is now, which need not be `queued`. For a control
  request, `action` is the first action record.
- The same key with a different request is refused with `conflict`,
  `retryable: false`, carrying `idempotency_key` and the `run_id` the key
  belongs to.
- The key is written to disk before the request is acknowledged, so it holds
  across a core restart.

- A key belongs to one route: the same key on a submit and on a steer are two
  keys.
- "The same request" is decided by a sha256 digest of the request body
  without `idempotency_key`, with object keys sorted (field order does not
  count), plus the route and, for steer and cancel, the `run_id` of the path.
  Every other field counts, `caller` included. A submit's `repo` is compared
  after canonicalization.
- Order on disk for a submit: the key and digest, then the run directory, then
  the worker. After a core restart, a key whose run reached event 1 is kept and
  replays that run; a key whose run was never established is released, so a
  repeat creates the run. A steer or cancel writes its key just before
  delivery; it is kept when the worker recorded the action (`run.control`) and
  released when the action was refused or never recorded, so a refusal does
  not use up the key.
- How long a key is remembered: as long as its run is in the store, and for 7
  days after the run ended. Keys past that are removed when the core starts.
  A repeat after that is a new request.

## Deadlines

- `deadline` is an optional absolute UTC timestamp on submit. It must be later
  than the core's clock, or the submit gets `invalid` with `field:
  "/deadline"`. It cannot be changed after submit.
- When the deadline passes while the run is `queued` or `running`, the run
  moves to `cancelling` with reason `deadline`, and then to `timed_out` once
  the harness has stopped. The other outcomes from `cancelling` (see the state
  machine) still apply. The run's worker enforces the deadline, so it holds
  across a core restart.
- With no deadline, a run has no time bound.
- (built, t13) While one of the run's questions is pending, the deadline does
  not advance: the time spent waiting is not counted against the run. The
  question has its own limit (`answer_by`). Once the last pending question has
  its answer, `deadline` on the run reports the time moved by the wait. The
  run's worker applies this rule on its own clock, like the deadline itself.

## Operator questions

Built (t13). The stub harness asks (a task line `ask:` or `approval:`), so
the path can be exercised without a real harness. Claude Code and OpenCode
report `answer` unsupported: the probe of plan task t1
(`docs/d2/probe-approvals.md`) shows both harnesses can ask and take one
answer in the same turn, held for up to 5 minutes, but their drivers here do
not raise questions yet. A 12 hour hold inside a real harness was not
measured.

- A run asks by appending `run.question` to its log. The `question` has an
  id, a `kind`, `text`, the `choices` the harness offers, whether free text
  and more than one choice are accepted, and `answer_by`. Everything in it
  that came from the harness is untrusted data.
- `kind` is `question` (the harness wants information) or `approval` (the
  harness wants a decision on one action, and `tool` may name it).
- A pending question is one with no `run.answer` yet. The run lists them in
  `pending_questions`, read from its log, so they are still pending after a
  core restart.
- `POST .../answer` answers one question. For a `question`, the request gives
  `answer` (free text, when `free_text` is true), `choice_ids` (ids from
  `choices`, more than one only when `multiple` is true), or both. For an
  `approval`, it gives `decision` (`approve` or `deny`); `answer` is then an
  optional reason that the harness shows the model. The core answers
  `invalid` when the request does not fit the question.
- An accepted answer is appended as `run.answer` and delivered into the same
  run exactly once. A second answer to the same question is refused with
  `conflict`.
- `answer_by` is the question's own time limit: 12 hours after it was asked,
  or less when the operator configured less (`questions.limitSeconds` in the
  core's config file, 1 to 43200; a higher value stops the core at start). When it passes with no answer,
  the run moves to `cancelling` with reason `question_limit` and ends
  `unanswered`.
- A harness that cannot ask reports `answer` as unsupported, and an answer
  sent to its run gets `unsupported` naming `answer`.
- An answer's `idempotency_key` is recorded on its action but not
  deduplicated: a repeat of an accepted answer is refused with `conflict`
  because the question already has its answer, so it still takes effect once.
- A question waits in the run's worker process. Its record survives a core
  restart; a worker that ends while a question is pending ends the run as any
  lost worker does (`unknown`).

## Capabilities and honest refusal

- Each harness publishes a capability document (`capabilities.json`). Every
  capability name is always present, with `supported` and, when it is not
  supported, a non-empty `reason`. `caveats` lists the known limits of a
  supported capability. An example is cancel that stops the turn but can leave
  a tool's child process running until the sandbox is deleted.
- A control action whose capability is not supported must be refused with
  `unsupported` and `capability` set to its name. It must never be dropped,
  queued for later or simulated.
- The document describes the harness as this core drives it, measured, not as
  the vendor advertises it. A capability that has not been verified is
  declared unsupported.

### Deferred capabilities

These capabilities use the `deferred` shape (`supported: false`, which the
schema enforces) for every harness in this API version. Making any of them
supportable is a MAJOR bump.

| Capability | How a client meets the refusal |
| --- | --- |
| `pause`, `resume` | `POST .../pause` or `.../resume` → `unsupported` |
| `continue_session` | submit with `session_id` → `unsupported` |
| `delegate` (agent-to-agent) | submit with `parent_run_id` → `unsupported` |

### Capabilities that 3.0 allows

In 2.0 these four were deferred. In 3.0 the schema lets a harness report
them as supported. A harness reports each one unsupported, with the reason,
until its driver does it.

| Capability | How a client meets the refusal today | Built by |
| --- | --- | --- |
| `answer` (operator questions) | supported by the stub; Claude Code and OpenCode: `POST .../answer` → `unsupported` | t13 (built) |
| `reconnect` (live control after a core restart) | steer or cancel a run with `live_control: false` → `unsupported` | t9 (built) |
| `worktree_isolation` (concurrent runs in one repository) | reported supported by every harness; there is no refusal | t8 (built) |
| `placement` (multi-host) | reported unsupported by every harness; submit for an agent on another node → `unsupported` | part two **(planned, part two)**; the shape is from t30 |

`worktree_isolation` means one clone of the repository per run, made from the
run's `base_commit`, with its own `runs/<run_id>` branch: a sandbox clone per
run for a sandboxed harness (the stub harness uses a temporary clone on the
host). It never means a git worktree on the host, and the host checkout and
index are never written. Its caveat in the capability document says this.
Two runs in one repository share nothing else that is fixed: each fetch back
into the host writes only its own `runs/<run_id>` ref.

### Limits, load and admission

The limits themselves are built (t8). The operator sets them in the core's
config file, the harness config file
(`${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/harness.json`, or the file
named by `CULTURE_AGENTS_HARNESS_CONFIG`), as
`{"limits": {"runsPerRepository": 2, "runsPerHost": 8}}`. Each value is a
whole number of at least 1, or null or absent for no limit; any other value or
key stops the core at start. The core reads the file when it starts. A run
counts as active while its state is active, including a run whose worker
survived a core restart; a run whose stored state cannot be read but whose
worker may be alive also counts, against every repository when its record
cannot be read either.

**(built, t17.)** A capability document carries three optional fields
about the core's own host. They never describe another host.

- `limits`: every limit by name, `runs_per_repository` and `runs_per_host`.
  `null` means the operator configured none, and then no submit is refused
  for it. There is no implicit limit. Limits come from the core's
  configuration, never from a request.
- `active_runs`: how many runs are active on the host now.
- `admission`: one entry per signal, `heat` and `gateway`. Each has a `state`
  (`admit`, `hold` or `unknown`), `consulted` (whether admission reads this
  signal for this harness), a `reason`, and `observed_at`. A missing or stale
  signal is `unknown`. It is never read as `admit`, and it is never a failure
  of the control plane.

The heat signal is read from heat-governor's `state.json` as it publishes it
(`$HEAT_GOVERNOR_STATE`, else `$XDG_RUNTIME_DIR/heat-governor/state.json`; `at`
in epoch seconds, `stale_after_s`, `admit`). The gateway signal is consulted for a
harness that uses the model gateway (OpenCode). The core asks `GET /status` at the origin of the
gateway URL the harness is configured with (`opencode.baseUrl`), with a 1 second timeout, and reads
its `admission` object (`admit`, `at` as RFC 3339, `stale_after_s`, optional `reason`; lobes-cli
0.99.0). A missing field, a stale or future-stamped sample, a timeout, a refused connection, an
error status or a redirect away from loopback reads `unknown`. For any other harness the signal is
`consulted: false`. A `hold` does not refuse a local submit in part one.

A local submit under an `unknown` consulted signal is admitted, and the submit response
then carries a `warnings` entry with code `signal_unknown` naming the signal.

**(planned, part two)** A submit that a consulted signal holds (`hold`, or
`unknown` for a submit from another host) is refused with `admission_held`.
Its `signal` names the signal (`heat` or `gateway`), the `state` that held the
submit and the `observed_at` of the reading (null when there is none). It is
retryable, and nothing is queued: the caller retries later or submits to
another host. The shape is in 3.0 (t30); no route returns it yet.

## Retention of finished runs

The core removes a finished run's directory (`<state>/runs/<run-id>/`) only when
all of these hold. Any doubt keeps the directory.

- The run's state is known and finished: its event log ends in `succeeded`,
  `failed` or `cancelled`. A run that reads `unknown`, a run whose record or
  log cannot be read, and a run whose worker may be alive are never removed.
- Its sandbox is not retained: there is no `retained.json`, or its `until` has
  passed.
- The retention period has passed since the later of the run's `ended_at` and
  the end of its sandbox retention.

The period is `CULTURE_AGENTS_RUN_RETENTION_DAYS` in the core's environment:
30 days when unset; `0`, `off` or any unusable value keeps every run. The core
checks at startup and on the reclaim interval. A removed run answers `not_found`.

Each finished run also keeps `summary.json`: its derived record and the byte
size of the event log it came from. It is a cache. The event log stays the
source of truth: a summary that is missing, invalid or whose size differs from
the log is ignored and rebuilt from the log, and the listing is the same
without it. Only finished runs have one, so listing, submit and attach do not
read the event logs of finished runs.

## Authorization and the allow-list

- Dispatch is denied by default. The core enforces this, and nothing in a
  request, task, prompt or persona can change it.
- The allow-list file is `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/allowlist.json`
  and validates against `allowlist.json`. It ships as
  `{"version": 1, "entries": []}`. A missing file means an empty list.
- A submit is allowed only when one entry matches its `agent_id`, `harness`
  and `repo` exactly, after the core canonicalizes the repository path
  (realpath). Entries have no wildcards. A file that does not validate counts
  as empty, and `agents doctor` reports it.
- **No route reads or writes the allow-list.** Only the operator edits it.
  Text in a task, a steer message, harness output, a memory record or an
  `extension` can never add an entry.
- `caller` (a `principal`) is recorded as supplied, as provenance: the run's
  `owner` is the submit's `caller`. In D1 the core does not authenticate it.
  Authority comes from the owner-only socket and the allow-list. Any
  connected client may control any run. Per-run ownership is issue #2's
  Decision 3, which is still open.
- `submitter` is what the core itself established about who submitted a
  run. For a request on the control socket it is `local_user` with the `uid`
  of the user that owns the socket. For a request from another core it is
  `member` with that member's `node`. No request field sets or changes it,
  and every request schema is closed, so a request that tries is `invalid`.
  A 3.0 core sets it on every run it creates **(planned, t11)**; it is absent
  on a run recorded before that. Part one does not enforce on it.
- `base_commit` is the commit of the repository the run starts from, resolved
  by the core when it accepts the submit **(built, t7)**; the worker builds the sandbox from it, not from the host's HEAD at that later time. It is absent on a
  run recorded before that.
- **Concurrent runs (t8):** any number of runs may be active in one
  canonical repository at once, each steered and cancelled on its own. There
  is no implicit limit: only a limit the operator configured refuses a submit,
  with `limit_reached`.

## Errors and CLI exit codes

Every non-2xx response body validates against `error.json`. `message` is one
sentence. For environment errors, the message includes a remediation hint.

| Code | HTTP | CLI exit | `retryable` | Extra fields | Meaning |
| --- | --- | --- | --- | --- | --- |
| `invalid` | 400 | 1 | false | `field` (optional) | The request breaks the schema or a rule in this README |
| `denied` | 403 | 1 | false | none | No allow-list entry matches |
| `not_found` | 404 | 1 | false | `run_id` (optional) | Unknown agent, harness, run or path |
| `conflict` | 409 | 1 | varies (see above) | `run_id`; `idempotency_key` or `question_id` (optional) | The run's state does not allow the action, or an idempotency key was used with a different request |
| `limit_reached` | 429 | 1 | true | `limit` (`name`, `value`, `active`, and `repo` for a repository limit) | A limit the operator configured has no room; nothing is queued |
| `admission_held` | 429 | 1 | true | `signal` (`name`, `state`, `observed_at`) | An admission signal holds the submit; nothing is queued. **(planned, part two)**: no route returns it yet |
| `unsupported` | 422 | 1 | false | `capability` | The capability is not supported (see above) |
| `incompatible_version` | 412 | 2 | false | `client_api_version`, `server_api_version` | The API versions are incompatible |
| `unavailable` | 503 | 2 | true | `retry_after_ms`, `run_id` (both optional) | A dependency is not reachable (sandbox gateway, harness, worker). With `retry_after_ms`: retry shortly |
| `internal` | 500 | 2 | false | none | Unexpected core failure |

CLI exit codes: 0 on success, 1 for a user error, 2 for an environment error.
The CLI also maps these cases, which produce no error body:

- The socket is missing, or the connection is refused or times out: exit 2.
  The CLI reports the error as `unavailable` with a hint to start the core.
- The core's response does not validate against its schema: exit 2, reported
  as `internal`. The CLI must not pass on an invalid payload.
- A version mismatch found by `GET /v1/version` on connect: exit 2, naming
  both versions.

## Extension field and vendor neutrality

- `extension` (`common.json` → `$defs/extension`) is the only open object in
  the contract. It may appear only as a property named `extension` on Run,
  the capability document and `run.output` data. It carries harness-specific
  data, for example a sandbox id or a raw part type.
- Consumers must not depend on its contents or branch on them. Its shape is
  not versioned. It is untrusted data.
- No schema or `api.json` may name a harness-runtime type, a sandbox-runtime
  type or a vendor-SDK type or package. `tests/contract_support.py` keeps the
  deny-list and the tests enforce it. Harness ids such as `claude-code` and
  `opencode` are free string values, not an enum, so swapping the harness
  runtime leaves this contract unchanged.
- Task text, steer messages, harness output, `extension` contents and memory
  records are data, never control commands. The core must not parse any of
  them into an action.

## Fixtures

- `fixtures/valid/<schema>/<target>.<label>.json` must validate, and
  `fixtures/invalid/<schema>/<target>.<label>.json` must be rejected.
  `<schema>` is the schema file's stem. `<target>` is `root` for the file's
  root schema, or else a `$defs` name. For example,
  `invalid/run/root.const-live-control-on-terminal-run.json` targets
  `run.json`.
- An invalid fixture's label starts with the one JSON Schema keyword it breaks
  (`required`, `pattern`, `const`, `enum`, `type`, `additionalProperties`,
  `minItems`, `maxItems`, `minimum`, `minLength`, `maxLength`, `not`), followed by the
  reason. Its top-level validation errors all carry that keyword. The only
  exception is an `anyOf` echo, which appears where a property such as event
  `data` is an `anyOf`.
- `fixtures/streams/valid/*.jsonl` are whole-run event logs, one event per
  line. Each obeys the cursor rule (1, 2, 3, ...), a single `run_id`, a first
  event `null` → `queued`, legal transitions with a matching `from`,
  nothing after the terminal state, and every `run.answer` naming a question
  that is pending at that point. `fixtures/streams/invalid/*.jsonl` each
  break one of these rules, and the file name says which.
- Fixtures are payloads exactly as sent on the wire, so a fake core may serve
  them as they are.
