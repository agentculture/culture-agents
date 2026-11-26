# Task report: t13, operator questions

Plan `d2-fleet-and-recovery`, task t13: ask, wait on disk, answer once, a
12 hour limit with a paused deadline. Covers c7, h7, c56, h44.

## What I built

Worker side (the worker owns the clock rule, as the plan says):

- `core/src/worker/questions.ts` (new): `QuestionDesk` gives a raised request
  its question id (`<node>-<agent>.qst.<ULID>`) and its `answer_by`. It holds a
  question while its answer is delivered, so a question takes exactly one
  answer. `PausableDeadline` pauses the run's deadline while any question is
  pending and adds the time spent waiting once the last one has its answer.
- `core/src/worker/answer.ts` (new): delivers an answer into the turn first,
  then appends `run.answer`, so `run.answer` means delivered (the same rule as
  steer). A failed delivery leaves the question pending and logs a non-fatal
  `run.error`. A driver without an ask path answers `unsupported`, capability
  `answer`.
- `core/src/worker/run-loop.ts`: a driver `question` event is appended
  durably as `run.question` before the worker starts the wait. The old
  absolute deadline timer is replaced by `checkClock()`, which runs at start,
  on every question and answer, and on every heartbeat. A question past its
  limit moves the run to `cancelling` with reason `question_limit`, and the
  run ends `unanswered`, not `timed_out`. Once the wait ends, the record's
  `deadline` reports the moved time. The worker takes a new
  `--question-limit-ms` (worker `main.ts`, `spawn.ts`).
- `core/src/worker/control.ts`, `delivery.ts`, `spawn.ts`: a new control op
  `answer`. `WorkerControl.answer` settles a lost reply from the log by
  looking for `run.answer`.
- `core/src/worker/driver.ts`: a new `question` driver event and an optional
  `Driver.answer(ref, reply)`. The harness's own id (`ref`) stays inside the
  worker.

Store and contract helpers:

- `core/src/store/questions.ts` (new): the pure rules both sides share: the
  pending list read from the log, the answer-fit check, and
  `questionLimitMs()`, which defaults to 12 hours, may be lower and is capped
  at 12 hours.
- `core/src/store/derive.ts`: every run now reports `pending_questions`, read
  from its log (always `[]` on a terminal run).
- `core/src/contract/ids.ts`: `buildQuestionId` and `isQuestionId`.

Core side:

- `core/src/runs/answer.ts` (new): steps 5 to 9 for `runs.answer`. Step 5 is
  the capability `answer`. Step 6 is the state check plus the question read
  from the log: a question the run never asked gives `not_found`; one already
  answered or past its limit gives `conflict` (not retryable); an answer that
  does not fit gives `invalid`. All three carry `question_id`. Then live
  control, then delivery. `unsupported` and `conflict` refusals against a
  live, controlled run are written as `run.refused`.
- `core/src/runs/service.ts`: `answer()`, plus a shared `target()` that `act`
  now uses too (the file is at 400 lines). `core/src/daemon/routes.ts` has a
  real `runs.answer` handler; `answer` is out of the always-refused set (only
  pause and resume stay there). `core/src/daemon/ports.ts` gains `answer`.
- `core/src/daemon/limits.ts`: `loadQuestionLimit()` reads
  `{"questions": {"limitSeconds": N}}` from the core's config file. N must be
  1 to 43200; a higher value stops the core at start. `daemon/main.ts` passes
  the limit to every worker.

Harness side:

- `common/types.ts`, `common/run-driver.ts`, `common/guard.ts`: a turn
  `question` event and `TurnHandle.answer`. The shared driver forwards
  answers. The guard refuses `answer` unless the capability document supports
  it.
- `common/capabilities.ts`: `answer` stays unsupported by default, with a
  reason (`NO_ASK_PATH`) that cites the probe: holds of up to 5 minutes
  measured, 12 hours not. `CapabilityInput.answer` lets a driver that asks
  report it supported.
- The stub (`stub/backend.ts`, `stub/index.ts`, `harness/index.ts`) asks. A
  task line `ask: <text>` (with an optional `choices: a, b`) or
  `approval: <text>` (deny skips the writes) raises a question and holds the
  turn. The stub reports `answer` supported with caveats, so the mock stage
  exercises the whole path.
- `worker/fake-driver.ts` (test driver): an `ask` step, plus the
  `noAnswer` and `answerError` options.

Docs: the contract README now marks the t13 behaviour as built, documents the
config key, says answers are not deduplicated by idempotency key, and states
that a 12 hour hold was not measured. CLAUDE.md, the explain text
(`culture_agents/explain/catalog_control.py`) and the config table in
`core/src/harness/config.ts` say the same. The stub's capability caveat says
that no real harness was measured holding a question for 12 hours.

## Choices I made where the plan was open (please review)

1. **Claude Code and OpenCode still report `answer` unsupported.** The
   instruction says to "build exactly what the probe record says each harness
   supports". The probe says both harnesses can ask. I did not build their
   driver ask paths: Claude Code needs `continueStream` and a turn loop over
   `turnState`; OpenCode needs `permission.asked` and `form.created` plus the
   reply routes. I could not run either live here (no sandbox, no
   credentials), and the contract only allows a capability to be reported
   supported once it is measured as this core drives it. The probe record
   itself says: "A harness whose driver is built without the ask path keeps
   reporting `answer` as unsupported." So both report unsupported, with a
   reason that names the probe. This is a deviation from a literal reading of
   the instruction. It leaves follow-up work: an ask path in each real driver,
   then a live check.
2. The question limit is set in seconds, under `questions.limitSeconds` in
   the core's config file (the file that already holds `limits`). The worker
   also caps it at 12 hours, so "never higher" holds on both sides.
3. A repeated answer with the same idempotency key is not replayed: it gets
   `conflict` because the question already has its answer. It still takes
   effect once. The contract README already limited dedup to submit, steer
   and cancel, and now says this.
4. The moved deadline is written to the run record when the wait ends (the
   last pending question answered). While a question is pending, the stored
   deadline stays at its value before the wait.
5. A question raised while the run is already `cancelling` is not recorded
   as pending; it gets a diagnostic output line instead.

## Acceptance criteria

1. **Proven.** "A question is appended to the run's event log before the run
   starts waiting; after a core restart it is listed as pending; an answer is
   delivered exactly once into the same run, and a second answer is refused."
   - `core/test/runs/questions.test.ts`, "a question survives a core restart
     and its answer is delivered into the same run exactly once". It uses the
     real daemon, real worker processes and the real stub driver. The core is
     killed with SIGKILL and restarted, the question is still in
     `pending_questions`, the answer is accepted (202), and a second answer
     gets `conflict` with `question_id`. Exactly one `run.answer` is logged,
     the stub echoes the answer in the same turn, and the run ends
     `succeeded`.
   - `core/test/worker/questions.test.ts`, "an answer is delivered exactly
     once…": two concurrent answers produce one acceptance; then a second
     answer, an unknown question and misfits are each refused; and
     `run.question` comes before `run.answer` in the log. The question is
     appended with `durable` set, before `checkClock()` and the wait.
2. **Proven.** "The question limit defaults to 12 hours and can be configured
   lower, never higher; the run's deadline does not advance while the
   question is pending (test with an injected clock)."
   - `core/test/worker/questions.test.ts` uses an injected clock throughout.
     "the run's deadline does not advance…": the clock is pushed an hour past
     the deadline while the question is pending and the run stays `running`;
     after the answer the deadline reads exactly one hour later, and the run
     then ends `timed_out` on the moved deadline. Also: "the default limit is
     12 hours", "a configured limit higher than 12 hours is capped", and "a
     configured lower limit is used".
   - `core/test/store/questions.test.ts`: `questionLimitMs`, plus
     `loadQuestionLimit` refusing 43201, 0, 1.5 and a string;
     `PausableDeadline` and `QuestionDesk` arithmetic.
   - `core/test/runs/questions.test.ts`, "a question limit set lower in the
     core's config file…": `limitSeconds: 1` gives an `answer_by` 1 s after
     the question.
3. **Proven.** "When the limit passes, the run ends in the terminal state
   that says the question went unanswered, not `timed_out`."
   - `core/test/worker/questions.test.ts`, "when a question's limit passes
     the run ends unanswered, not timed_out, even with a deadline also
     passed": the log reads `running → cancelling (question_limit) →
     unanswered (question_limit)`, never `timed_out`, and a late answer gets
     `conflict`.
   - `core/test/runs/questions.test.ts`: the same through the real daemon,
     with the limit from the config file.
4. **Proven,** with choice 1 above. "A harness that cannot ask reports the
   capability as unsupported and an answer sent to its run gets the typed
   unsupported error; the stub driver can ask, so the mock stage exercises
   the path."
   - `core/test/harness/registry.test.ts`: claude-code and opencode report
     `answer` unsupported, with the probe reason; the stub reports it
     supported.
   - `core/test/runs/questions.test.ts`, "an answer to a run whose harness
     cannot ask is refused unsupported, naming answer, and logged": the
     refusal is also a `run.refused`.
   - `core/test/worker/questions.test.ts`, "a driver without an ask path…":
     the worker-level refusal.
   - The stub asks in the restart test above. The D2 acceptance suite
     (`tests/acceptance/d2/`) does not exist yet; it belongs to another task.
     The core mock path is exercised, but no Python acceptance test of the
     question path was added.

## Tests I changed (none deleted)

- `core/test/daemon/api.test.ts`: "pause, resume and answer are always
  unsupported" is now "pause and resume are always unsupported" (2 recorded
  refusals instead of 3). A new test checks that `answer` validates and
  reaches the service.
- `core/test/runs/control.test.ts`: renamed only. The fake harness cannot ask,
  so its answer is still refused and recorded; the assertions did not change.
- `core/test/harness/registry.test.ts` and
  `core/test/harness/contract-suite.ts`: `answer` is checked per harness, and
  the count of undeclared capabilities is 5 for a driver that asks, 6
  otherwise.
- `core/test/runs/child.ts` and `support.ts`: a fake harness may declare
  `ask: true`. `core/test/daemon/fake-service.ts` implements `answer`.

## Commands run and final results

- `cd core && npm run build && npm test`: **660 tests, 648 pass, 0 fail, 12
  skipped**. The skips are the existing opt-in live, broker and OpenShell
  tests, each reported NOT VERIFIED.
- `npm run typecheck`: pass. `npm run lint`: pass. `npm run
  check:contract-types`: pass.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto -q` (after
  building the core): **1672 passed, 9 skipped, 1 failed**. The failure is
  `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`:
  `uv build` cannot reach the package index (tcp connect: permission
  denied). Earlier task reports (for example t17) record the same failure. I
  did not rerun it with my changes stashed.
- `python3 scripts/check-example-node.py`, `scripts/scan-secrets.py` and
  `scripts/check-file-length.py`: clean (`run-loop.ts` and `service.ts` are
  at exactly 400 lines).
- `black --check`, `isort --check-only`: clean. `flake8 -j 1 culture_agents
  tests`: clean. It needs `-j 1` because the sandbox forbids the
  multiprocessing semaphores.
- **Not run:** markdownlint-cli2 (not installed here), `teken cli doctor`,
  `bandit`, `harness-smoke.py`, and any live harness turn.

## Not measured

- No real harness question was raised through this core, and the Claude Code
  and OpenCode ask paths are not built (choice 1).
- No 12 hour hold was run anywhere. The 12 hour default is proven only with
  the injected clock. The probe's longest hold was 5 minutes, and the README,
  the capability reasons and the stub caveat say so.
- A worker that ends while a question is pending: the run ends `unknown`,
  like any lost worker. That follows from existing behaviour, and I did not
  add a test for it here.

## Files left unchanged on purpose

- `contract/*.json` and fixtures: the 3.0 shapes already held everything t13
  needed. `api.json` keeps `"d1": "unsupported"` (it records what D1 did) and
  `"cli": "agents runs answer (planned)"` (the CLI verb is t16).
- `culture_agents/cli/_commands/runs.py`: no `answer` verb (t16).
- `core/src/harness/claude-code/*` and `core/src/harness/opencode/*`: see
  choice 1.
- `docs/d2/probe-approvals.md` and `spikes/`: not to be edited.
