# TASK-REPORT: pr-15 review, reattach after a core restart

Area: `core/src/runs/reattach.ts`, `core/src/runs/scan.ts`, one line of `core/src/runs/service.ts`.

## Findings

### 1. MUST FIX: one missed ping makes a live run `unknown` for the daemon's lifetime: FIXED

- Tests (new file `core/test/runs/reattach-retry.test.ts`):
  - "a live worker that misses its first ping is never reported unknown, is refused unavailable, and is reattached once it answers"
    (worker SIGSTOPped across a 300 ms ping, then SIGCONT). Asserts: state `running`, `terminal: false`,
    `live_control: false`, schema-valid; `cancel` gets `unavailable` with `run_id` and `retry_after_ms`;
    `getResult` is `conflict` (no result yet); the control call made a new attempt; after SIGCONT the
    backoff reattaches with no control call; cancel is accepted and the run ends `cancelled`.
    **Seen failing first: yes** (`expected 'running', actual 'unknown'`).
  - "a stopped worker is reattached by the next control call after it resumes".
    **Seen failing first: yes** (steer refused: "run ... is unknown").
- Fix:
  - `reattach.ts`: the one-attempt-per-run `attempted` set is gone. `begin` starts a new attempt
    whenever none is running and the run is not controlled, so every control call retries. A live
    worker that does not answer gets a background retry on a bounded backoff (500 ms doubling to
    30 s, unref'd timer), for as long as `reconnectWorker` finds it alive. The retry stops when the
    worker answers or is gone. An error that leaves liveness unknown is retried on the next control
    call, as before.
  - `scan.ts`: the `unknown` overlay (and the `unresponsive` option) is removed. A live worker's run
    keeps its logged state with `live_control: false`. `unknown` comes only from the store's
    existing settle (no live worker and no terminal event). Control calls already answer
    `unavailable` with `retry_after_ms` when there is no control channel (control.ts / answer.ts step 7).
  - `service.ts`: only the `unresponsive:` option in the scan options was removed.
- Existing test changed because the finding requires the behaviour to change:
  `core/test/runs/reattach.test.ts` "a worker whose control socket does not answer ..." asserted
  `unknown` and a steer refused `conflict`. It now asserts `running`, `terminal: false`,
  `live_control: false`, steer `unavailable` with `retry_after_ms`, no signal sent, and that the
  terminal run is never reattached. Since attempts now repeat, "calls is exactly [mute]" became
  "at least one call, every call for mute". Nothing else was loosened.
- Docs: `contract/README.md` ("After a core restart", t9 paragraph) and `docs/d2/part-one.md`
  (table row and restart bullet) now describe this behaviour. I did not touch the "(planned, t9)"
  label, which belongs to another finding.

### 2. SHOULD FIX: the `unknown` overlay keeps `pending_questions`: FIXED

- Test: "every run read while its live worker's control socket is silent validates against the run
  schema" (stub-ask run with a pending question, core killed, socket removed so the worker is alive
  but silent). It validates `getRun` and every `listRuns` entry against `run`, and checks that a
  terminal run has no pending questions. **Seen failing first: yes** (`/pending_questions maxItems`
  on the `unknown` run).
- Fix: the same change as finding 1. No overlay reports a run terminal any more. The store's own
  `unknown` settle already derives an empty `pending_questions` (validated in `test/store/derive.test.ts`).

## Commands and final counts

In `core/` with the node_modules symlink, which is removed again:

- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: clean.
- `npm test`: tests 686, pass 671, fail 3, skipped 12. Failing: "with the broker down a run
  reaches the same terminal state ...", "SIGKILL of the core signals no worker ...", "a worker
  survives a daemon SIGKILL ...". These are timing failures. The machine had load average 60-80
  from parallel agents. All three pass when run alone, on this branch and on the base commit
  d9c16af. The base commit's full suite, run under the same load, fails the same three
  (683 tests, 668 pass, 3 fail, 12 skipped). My three new tests pass inside the full run.
- `node --test dist/test/runs/reattach-retry.test.js dist/test/runs/reattach.test.js dist/test/runs/restart.test.js`: 12 pass, 0 fail.

From the repository root, after building the core:

- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1754 passed, 2 failed, 13 skipped.
  - `test_a_built_wheel_holds_the_schemas_byte_for_byte`: fails here because there is no network (known, not mine).
  - `tests/acceptance/d1/test_mock.py::test_submit_returns_a_run_id_in_under_2_seconds_and_the_task_completes`:
    a timing failure under load. It passed when re-run alone (1 passed). No Python file was changed.
- `scripts/check-file-length.py`, `scripts/check-example-node.py`, `scripts/scan-secrets.py`: clean.

## Not run / assumed

- markdownlint-cli2 is not installed here, so it was not run. Its config disables line length
  (MD013), and the doc edits are plain prose and one table cell.
- The backoff never gives up while the worker is alive. Its timer is unref'd, so it does not keep
  the daemon running. The service has no stop hook, so timers are not cleared at shutdown. A timer
  that fires after the worker has gone makes one more liveness read and then stops.
