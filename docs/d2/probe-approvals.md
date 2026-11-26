# D2 probe: can a harness ask its operator and wait

Plan task t1 of [`../plans/2026-11-26-d2-fleet-and-recovery.md`](../plans/2026-11-26-d2-fleet-and-recovery.md).
Run on 2026-11-26 on the fleet host (x86_64).

**Result: both harnesses work.** Claude Code (through the AI SDK adapter) and
OpenCode v2 (through its own server API) each raised a request to the
operator, held the turn with nothing written, and took one answer back into
the same turn. Both did it for a tool approval (approved and denied) and for a
free-text question. The operator-question tasks of the plan are not cut down:
the honesty condition of the spec ("at least one real harness can ask and wait
without allow-all approvals") holds for two harnesses.

Every result below has a run behind it. Each check was run once, except where
the table lists a second run with a longer hold. What was not measured is
listed under [Not measured](#not-measured).

## Environment

Every run was inside an OpenShell sandbox, created the way a driver creates
it: the built core's `SandboxWorkspaceFactory`, one sandbox per run, the
repository handed in as a git bundle, the run image and the credential
providers from the core's harness configuration. Nothing was run directly on
the host, except one start of `opencode serve` to read `/openapi.json` (no
model call, scratch state directories).

| Component | Version |
| --- | --- |
| OpenShell CLI and gateway | 0.1.10 |
| Node.js (host) | 24.13.1 |
| `ai` | 7.0.181 (through `@ai-sdk/harness`) |
| `@ai-sdk/harness` | 1.0.192 |
| `@ai-sdk/harness-claude-code` | 1.0.196 |
| OpenCode | 2.3.2 |
| Run image | `culture-agents-run:dev`, `sha256:eafb88eefbe7…` |
| Providers attached | `claude-sub` (Claude Code), `lobes` (OpenCode) |
| Models | Claude Code `haiku`, OpenCode `gateway/worker` (local model) |

Sandboxes were named with the prefix `t1q-` and each probe deleted its own.

## How to run

The probes are in [`spikes/d2-approvals/`](../../spikes/d2-approvals/). They
import the built core, so build it first.

```bash
(cd core && npm ci && npm run build)
# For these commands only: the openshell binary on PATH and
# OPENSHELL_LOCAL_TLS_DIR pointing at the gateway's client TLS directory.
cd spikes/d2-approvals
node claude-probe.mjs approve            # permissionMode allow-reads
node claude-probe.mjs deny
node claude-probe.mjs question
node claude-probe.mjs question allow-all
node opencode-probe.mjs approve
node opencode-probe.mjs deny
node opencode-probe.mjs question
PROBE_TAG=-hold300 PROBE_HOLD_MS=300000 node claude-probe.mjs approve     # 5 minute hold
PROBE_TAG=-hold300 PROBE_HOLD_MS=300000 node claude-probe.mjs question
PROBE_TAG=-hold300 PROBE_HOLD_MS=300000 node opencode-probe.mjs question
```

Each probe gives the task to the model, waits for the request, records the
sandbox's files, holds for `PROBE_HOLD_MS` (default 20 s) without answering,
records the files again, answers once, and checks the result in the sandbox.
A probe passes only when a request was raised, nothing was written during the
hold, and the answer had the expected effect. The stdout of each run is in
`spikes/d2-approvals/evidence/<name>.txt` and the stream parts, server events
and API calls in `<name>.ndjson`. No model call has a time limit.

## Claude Code through the AI SDK adapter

**Verdict: works.**

### Calls used

- `new HarnessAgent({ harness: createClaudeCode({ auth: {} }), permissionMode })`
  with `permissionMode` `allow-reads` (edits and shell commands need approval)
  instead of today's `allow-all` (`core/src/harness/claude-code/agent.ts`).
- `agent.stream({ session, prompt })`. When the harness needs the operator, the
  stream **ends** with `finishReason: "tool-calls"` and the session's
  `turnState` becomes `awaiting-approval` or `awaiting-tool-result`. The turn
  is not over: Claude Code and the bridge keep running in the sandbox.
- An approval arrives as a `tool-approval-request` stream part carrying an
  `approvalId` (equal to the tool call id, `toolu_…`), after the `tool-call`
  part it belongs to.
- A question arrives as a `tool-call` part named `askUserQuestions` (Claude
  Code's `AskUserQuestion`) with `providerExecuted: false`. Its input is
  `{ questions: [{ id, question, header, options: [{ id, label, description }], allowMultiple, allowFreeForm }] }`.
- The answer goes back with
  `agent.continueStream({ session, toolApprovalContinuations, toolResultContinuations })`:
  an approval as `{ type: "tool-approval-response", approvalId, approved, reason? }`,
  a question's answer as a `tool-result` part for the same `toolCallId` whose
  output is `{ type: "json", value: { action: "answered", answers: { "<question id>": { optionIds: [], freeform: "<text>" } } } }`.
  The returned stream continues the same turn.

### Observed

| Check | Mode | Hold | Result | Observed |
| --- | --- | --- | --- | --- |
| approve | `allow-reads` | 20 s | pass | `tool-approval-request` for `write` at 4.6 s; stream ended, `turnState awaiting-approval`; files `README` before and after the hold; approved at 24.6 s; `tool-result write` at 25.4 s; `approved.txt` contains `yes`; final text `done` |
| deny | `allow-reads` | 20 s | pass | same request; denied with the reason `The operator said no: probe-denial-7341.`; no file written; the model's final text quotes the reason |
| question | `allow-reads` | 20 s | pass | `askUserQuestions` tool call at 3.7 s; `turnState awaiting-tool-result`; files unchanged over the hold; answered `ultraviolet-7341`; the following `write` raised its own approval, which was approved; `colour.txt` contains `ultraviolet-7341` |
| question | `allow-all` | 20 s | pass | the same question was raised and held under today's `allow-all`; after the answer the write ran without an approval; `colour.txt` contains `ultraviolet-7341` |
| approve | `allow-reads` | 300 s | pass | held 300 s with files unchanged; approved at 305.0 s; file written at 305.7 s |
| question | `allow-reads` | 300 s | pass | held 300 s with files unchanged; answered at 304.1 s; `colour.txt` written after one more approval |

Output of the first run (`evidence/claude-approve.txt`, sandbox lines left out):

```text
[1.0s] createSession, model haiku, permissionMode allow-reads
[4.5s] tool-call write {"file_path":"approved.txt","content":"yes\n"}
[4.6s] tool-approval-request toolu_01E18jAunKxo6KLTCLAXtNxj for write
[4.6s] stream ended: finishReason "tool-calls", session.turnState awaiting-approval, 1 approval(s) and 0 question(s) pending
[4.6s] held, before the answer: files [README], claude processes in sandbox 3
[4.6s] holding the turn for 20000 ms with no answer
[24.6s] held, after the wait: files [README], claude processes in sandbox 2
[24.6s] answering into the same turn: {"toolApprovalContinuations":[{"type":"tool-approval-response","approvalId":"toolu_01E18jAunKxo6KLTCLAXtNxj","approved":true}],"toolResultContinuations":[]}
[25.4s] tool-result write {"type":"create","filePath":"approved.txt","content":"yes\n", ...}
[27.2s] stream ended: finishReason "stop", session.turnState idle, 0 approval(s) and 0 question(s) pending
[27.2s] approved.txt: "yes"; colour.txt: ""
[32.7s] RESULT claude-code approve (allow-reads): PASS
```

### What the driver has to change

- `core/src/harness/claude-code/map.ts` turns a `tool-approval-request` into a
  run error today. It has to become a question.
- The driver treats the end of the stream as the end of the turn. With a
  pending request the stream ends early, so the driver has to read
  `session.turnState` (or count the pending requests) and call
  `continueStream` once the answer arrives.
- One turn can ask more than once (the question run asked twice), so the
  driver loops.
- A question does not need a permission mode other than `allow-all`: Claude
  Code's `AskUserQuestion` is held by the adapter in every mode. Tool
  approvals need `allow-reads` or `allow-edits`.

## OpenCode v2 through its server API

**Verdict: works.**

### Calls used

Routes are from the server's own `/openapi.json` (142 paths), OpenCode 2.3.2.

- `POST /api/session` with `permissions: [{ "action": "*", "resource": "*", "effect": "ask" }]`
  instead of today's `"effect": "allow"` (`core/src/harness/opencode/client.ts`).
  Effects are `allow`, `deny` and `ask`.
- `POST /api/session/{id}/prompt` as today.
- `GET /api/event` delivers `permission.asked` with
  `{ id: "per_…", sessionID, action, resources, save, metadata, source }` when a
  tool needs approval, and `form.created` with
  `{ form: { id: "frm_…", sessionID, title, metadata: { kind: "question" }, fields: [{ key, title, description, type, options, custom }] } }`
  when the model calls its `question` tool.
- The pending requests can be read at any time, without the event stream:
  `GET /api/session/{id}/permission` and `GET /api/session/{id}/form`.
- The answer: `POST /api/session/{id}/permission/{requestID}/reply` with
  `{ "decision": "once" | "always" | "reject", "message"?: string }`, or
  `POST /api/session/{id}/form/{formID}/reply` with
  `{ "answer": { "<field key>": value } }`. The server then emits
  `permission.replied` or `form.replied` and the same execution continues.

### Observed

| Check | Permissions | Hold | Result | Observed |
| --- | --- | --- | --- | --- |
| approve | `ask` for everything | 20 s | pass | `permission.asked` (`action: edit`, `resources: ["approved.txt"]`) at 9.1 s; during the hold the session stayed in `GET /api/session/active` as `running`, 1 pending permission, files `README`; reply `once` at 29.1 s; `session.tool.success` at once; `approved.txt` contains `yes`; `session.execution.succeeded`, final text `done` |
| deny | `ask` for everything | 20 s | pass | same request; reply `reject` with the message `The operator said no: probe-denial-7341.`; `session.tool.failed` with `{"type":"permission.rejected","message":"The operator said no: probe-denial-7341."}`; no file written; the model's final text is the message |
| question | `allow` for everything | 20 s | pass | the model called `question`; `form.created` with one string field `q0` (options `red`, `green`, `custom: true`) at 6.5 s; 1 pending form over the hold, files unchanged; reply `{"answer":{"q0":"ultraviolet-7341"}}`; the tool result reads `User has answered your questions: "Which colour should I use?"="ultraviolet-7341"`; `colour.txt` contains `ultraviolet-7341` |
| question | `allow` for everything | 300 s | pass | `form.created` at 6.7 s; held 300 s with 1 pending form, session active, files unchanged; answered at 306.8 s; `colour.txt` contains `ultraviolet-7341` |

Output of the first run (`evidence/opencode-approve.txt`, sandbox lines left
out and the permission request shortened):

```text
[1.3s] session ses_… created with permissions [{"action":"*","resource":"*","effect":"ask"}]
[1.8s] prompt accepted; waiting for the model (no timeout)
[9.1s] tool called: {"path":"/sandbox/work/approved.txt","content":"yes"}
[9.1s] permission raised: {"id":"per_218e722bf001o4yB9EvdWnkUWw","sessionID":"ses_…","action":"edit","resources":["approved.txt"],"save":["*"], ...}
[9.1s] held, before the answer: files [README], session active true, pending permissions 1, pending forms 0
[9.1s] holding the turn for 20000 ms with no answer
[29.1s] held, after the wait: files [README], session active true, pending permissions 1, pending forms 0
[29.1s] answering into the same turn: POST /api/session/{id}/permission/per_218e722bf001o4yB9EvdWnkUWw/reply {"decision":"once"}
[29.1s] permission.replied: {"sessionID":"ses_…","requestID":"per_218e722bf001o4yB9EvdWnkUWw","reply":"once"}
[29.1s] session.tool.success: [{"type":"text","text":"Created file successfully: approved.txt"}]
[35.6s] execution ended with session.execution.succeeded; session outcome "succeeded"
[35.6s] approved.txt: "yes"; colour.txt: ""
[41.0s] RESULT opencode approve: PASS
```

### What the driver has to change

- `core/src/harness/opencode/map.ts` ignores `permission.asked` and
  `form.created`. They have to become questions. Because the event stream is
  volatile, the driver should also read the two pending lists when it
  reconnects, so a request raised during a gap is not lost.
- While a request is pending the session stays active (`running`), so the
  driver's end-of-turn check (wait route, session route, active list) does not
  mistake the wait for the end.
- A question needs no permission change: the `question` tool raised a form
  under the allow-everything rule the driver uses today.

## What the capability report must say

The `answer` capability is `deferred` for every harness today
(`core/src/harness/common/capabilities.ts`). After the operator-question task
is built to this record:

| Harness | `answer` | Reason and caveats the report must carry |
| --- | --- | --- |
| claude-code | supported | Measured live. A question (`AskUserQuestion`) is held and answered in every permission mode. A tool approval is raised only when the run's permission mode is not allow-all; under allow-all the harness never asks for approval. An answer is free text for a question and approve or deny (with a reason the model sees) for an approval. One turn can ask more than once. Longest wait measured: 5 minutes. |
| opencode | supported | Measured live. A question (the `question` tool, a server form) is held and answered under any permission rule. A tool approval is raised only when the session's permission rule for that action is `ask`; under the allow rule the harness never asks for approval. An answer is the form's field values for a question and `once` or `reject` (with a message the model sees) for an approval. Pending requests are read from the server, not only from the volatile event stream. Longest wait measured: 5 minutes for a question. |
| stub | supported | Not part of this probe; the plan requires the stub driver to ask so the mock stage exercises the path. |

Until that task ships, both reports keep `answer` unsupported with the
existing reason: the capability is what the driver does, not what the harness
could do. A harness whose driver is built without the ask path keeps
reporting `answer` as unsupported, and an answer sent to its run gets the
typed `unsupported` error.

The report must not say or imply any of the following, because none was
measured: that a question survives 12 hours inside the harness, that a
pending request survives the end of the worker process that holds the
session, or that steer and cancel behave as documented while a request is
pending.

## What this settles of Decision 1

Decision 1 of issue #2 ("what remains an SDK adapter vs an AgentCulture
execution feature") stays **open**. This probe settles one row of the table
[`../d0/decisions.md`](../d0/decisions.md) asks for, and removes one item from
its "not verified" list.

| Capability | Where it lives | Probe result |
| --- | --- | --- |
| answer, Claude Code: raising the request, holding the turn, delivering the answer | the AI SDK adapter (`tool-approval-request`, `askUserQuestions`, `continueStream`) | works, measured here |
| answer, OpenCode v2: the same three | OpenCode's server API, driven by our own client; no AI SDK adapter is involved (the adapter cannot start OpenCode v2, see `../d0/probe.md`) | works, measured here |
| answer, both: the question's id in the contract, the on-disk record, pending after a core restart, exactly-once delivery, the 12 hour limit, the paused run deadline, who may answer | culture-agents (ours) | not a probe matter; plan task t13 |

- Settled: "approvals other than `allow-all`" is no longer unverified for the
  Claude Code adapter. `permissionMode: "allow-reads"` raises approval
  requests and takes approve and deny decisions.
- Settled: the harness side of `answer` needs no vendor-SDK fallback for
  Claude Code (claim `c58` is not triggered for this capability).
- Not settled: `doStop`, `doDetach`, resume across processes, host tools, the
  rows for dispatch, placement, idempotency, sessions and resume, and the pin
  policy for the adapter versions. The adapter API is still experimental; the
  calls above are tied to the pinned versions in the table.

No AI SDK type has to enter the public contract: a question is an id, a kind
(approval or question), text, optional choices; an answer is an id plus a
decision or values.

## Not measured

- **A 12 hour wait.** The longest hold was 5 minutes per harness. The Claude
  Code adapter has a `questionTimeoutMs` setting whose unset value is "the
  Claude Code default"; that default was not found and no question was held
  long enough to hit it. OpenCode's limit, if it has one, was not looked for.
- **The worker process ending while a request is pending.** Every run kept
  the session in one process. The AI SDK has `suspendTurn`, `detach` and
  `createSession({ continueFrom })` carrying `pendingToolApprovals`; none was
  run. For OpenCode the pending lists were read through the API, but not from
  a second process after the first one exited.
- **Steer or cancel while a request is pending**, and cancelling a request
  (`DELETE /api/session/{id}/form/{formID}`, an AI SDK `cancelled` answer).
- **More than one pending request at a time**, and a second answer to the
  same request (the plan's "a second answer is refused" is ours to enforce).
- **OpenCode `always`** and saved permissions; **Claude Code `allow-edits`**;
  option-id answers (only free text was sent).
- **Repetition.** One trial per check; three checks were run a second time with the 5 minute hold. An OpenCode approval was held for 20 s only.
  Models: `haiku` and the local `gateway/worker`; another model may decline to
  call the question tool.
- **The same checks on the host**, outside a sandbox. Not needed: production
  runs in the sandbox, and that is where every check ran.
