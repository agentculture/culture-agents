# culture-agents control-plane contract

API version **2.0** (single source: `api.json` → `api_version`).

This directory is the contract between the TypeScript core daemon and every
client of it, starting with the Python `agents` CLI. The JSON Schemas
(draft 2020-12) fix the payload shapes. This README fixes the rules the
schemas cannot express. Both sides validate against these same files and
reuse the same fixtures. Generate types and validators from the schemas; never
copy them by hand.

Scope: D1 (single host, no chat). Everything deferred beyond D1 is listed in
[Deferred capabilities](#deferred-capabilities), and the contract reports it
as `unsupported`. Nothing deferred is silently missing.

Key words: **must**, **must not** and **may** are normative.

## Files

| File | Root schema | `$defs` used by routes |
| --- | --- | --- |
| `common.json` | none | identifiers, `timestamp`, `principal`, `extension` |
| `agent.json` | Agent | `agent_list` |
| `session.json` | Session | none |
| `run.json` | Run | `state`, `terminal_state`, `run_list`, `run_result` |
| `control-action.json` | action record | `submit_request`, `submit_response`, `steer_request`, `cancel_request`, `pause_request`, `resume_request`, `answer_request`, `accepted_response` |
| `event.json` | Event (log entry and stream item) | `event_page` |
| `capabilities.json` | harness capability document | `capability_set`, `capabilities_list` |
| `error.json` | error response `{"error": {...}}` | `error`, `code` |
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

- **Mesh id**, written `<node>-<agent>`, for example `spark-culture-agents`.
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
| `runs.pause`, `runs.resume`, `runs.answer` | `POST /v1/runs/{run_id}/<verb>` | never: always `unsupported` | none in D1 |

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
6. The repository already has an active run → `busy`.
7. The core creates the session and run, then starts the worker. The worker
   writes its PID, its event log with event 1 (`run.state`, `null` →
   `queued`) and its cursor to disk. Only after that does the core answer 201
   with the run in state `queued`.

Run-scoped control routes (`steer`, `cancel`, `pause`, `resume`, `answer`):

1. The version header → `incompatible_version`.
2. The path `run_id` format → `invalid`. The run exists → `not_found`.
3. The body against the route's request schema → `invalid`.
4. A deferred action (`pause`, `resume`, `answer`) → `unsupported`, naming that
   capability.
5. The run's harness capability document does not support the action (`steer`
   or `cancel`) → `unsupported`, naming it.
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
| `cancelling` | `cancelled`, `timed_out`, `succeeded`, `failed`, `unknown` |
| `succeeded`, `failed`, `cancelled`, `timed_out`, `unknown` | none (terminal) |

- **Active** states are `queued`, `running` and `cancelling`. **Terminal**
  states are `succeeded`, `failed`, `cancelled`, `timed_out` and `unknown`.
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
- A run moves to `cancelled` or `timed_out` according to what first moved it
  into `cancelling`. A later deadline does not turn a cancel into
  `timed_out`.
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

## Idempotency keys (D1)

`submit_request` and every control request accept an optional
`idempotency_key`. In D1 the key is **recorded and returned, and that is
all**. It appears on the run (`idempotency_key`) or on the action record,
exactly as sent.

**D1 does not promise deduplication.** Two submits with the same key create
two runs, and two steers with the same key deliver twice. The core neither
compares keys nor rejects reuse. Clients must not treat a retry as safe. A
client whose submit timed out should run `runs list` and look for the key
before it resubmits. Deduplication is planned for D2 and will be a versioned
behaviour change.

## Deadlines

- `deadline` is an optional absolute UTC timestamp on submit. It must be later
  than the core's clock, or the submit gets `invalid` with `field:
  "/deadline"`. It cannot be changed after submit.
- When the deadline passes while the run is `queued` or `running`, the run
  moves to `cancelling` with reason `deadline`, and then to `timed_out` once
  the harness has stopped. The other outcomes from `cancelling` (see the state
  machine) still apply. The run's worker enforces the deadline, so it holds
  across a core restart.
- With no deadline, a run has no time bound in D1.

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
| `answer` (operator questions) | `POST .../answer` → `unsupported` |
| `continue_session` | submit with `session_id` → `unsupported` |
| `delegate` (agent-to-agent) | submit with `parent_run_id` → `unsupported` |
| `placement` (multi-host) | submit for an agent on another node → `unsupported` |
| `reconnect` (live control after a core restart) | steer or cancel a run with `live_control: false` → `unsupported` |
| `worktree_isolation` (concurrent runs in one repo) | a second submit for a busy repo → `busy` |

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
- **Busy rule:** at most one active run per canonical repository path. A
  second submit gets `busy`, which carries `active_run_id` and `repo`. A run
  with `live_control: false` that is still active also holds its repository.

## Errors and CLI exit codes

Every non-2xx response body validates against `error.json`. `message` is one
sentence. For environment errors, the message includes a remediation hint.

| Code | HTTP | CLI exit | `retryable` | Extra fields | Meaning |
| --- | --- | --- | --- | --- | --- |
| `invalid` | 400 | 1 | false | `field` (optional) | The request breaks the schema or a rule in this README |
| `denied` | 403 | 1 | false | none | No allow-list entry matches |
| `not_found` | 404 | 1 | false | `run_id` (optional) | Unknown agent, harness, run or path |
| `busy` | 409 | 1 | true | `active_run_id`, `repo` | The repository already has an active run |
| `conflict` | 409 | 1 | varies (see above) | `run_id` | The run's state does not allow the action |
| `unsupported` | 422 | 1 | false | `capability` | The capability is not supported (see above) |
| `incompatible_version` | 412 | 2 | false | `client_api_version`, `server_api_version` | The API versions are incompatible |
| `unavailable` | 503 | 2 | true | none | A dependency is not reachable (sandbox gateway, harness, worker) |
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
  event `null` → `queued`, legal transitions with a matching `from`, and
  nothing after the terminal state. `fixtures/streams/invalid/*.jsonl` each
  break one of these rules, and the file name says which.
- Fixtures are payloads exactly as sent on the wire, so a fake core may serve
  them as they are.
