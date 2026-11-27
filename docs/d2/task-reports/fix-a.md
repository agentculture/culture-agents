# Task report: idempotency-key findings from the review of pull request 15

Area: idempotency keys (`docs/d2/reviews/pr-15-review.md`, must fix 1 and 2,
should fix 12, nits). Work is in commits `b662d4e` (code and tests) and
`826363f` (contract and docs).

## Findings

### 1. MUST FIX: a slow steer releases its key and is delivered again. Fixed

- Test: `core/test/runs/idempotency-settle.test.ts`, "a steer slower than the
  steer timeout keeps its key reserved: a repeat is unavailable, never
  delivered again, then replayed". The service runs in-process with a 200 ms
  steer timeout and a fake harness that takes 1500 ms to accept a steer.
- Seen failing first: yes. On the old code the key was gone after the first
  `unavailable`. With that assertion skipped, the old code delivered the
  repeat again (it timed out a second time), so the steer was not replayed.
- The read-only half (a core crash during a delivery): test "after a core
  crash during a delivery, start-up keeps the key of a live worker's action
  reserved". It covers both steer and cancel. Seen failing first: yes (the old
  `recoverKeys` released both keys).
- Fix:
  - `store/idempotency.ts`: a new `actionOutcome` settles a steer or cancel
    from the event log:
    - yes: the log has `run.control` for the action;
    - no: the run directory is gone, the log has `run.refused` or the
      `run.error` naming the action id, the run is terminal without it, or the
      worker is gone;
    - unknown: anything else, which keeps the key reserved. A repeat then gets
      `unavailable` with `retry_after_ms` and nothing is delivered.
  - `settleKey` and `recoverKeys` use `actionOutcome`.
  - `runs/control.ts`: a refusal the worker itself answered is now a
    `WorkerRefusedError`.
  - `runs/service.ts` `keyed` catch: a `WorkerRefusedError` releases the key;
    every other failure after the key was written goes through `settleKey`.
- Guard test, which passed both before and after the fix: "a steer the harness
  refused after the timeout releases its key once the log shows the refusal".
  It shows that a pending key does not stay stuck once the log records the
  refusal.
- Test-only plumbing: `worker.steerTimeoutMs` (RunServiceOptions, spawn
  options; the default stays 8000 ms).
- Cancel: the worker writes `run.control` before it stops, so a slow cancel is
  hard to provoke. Cancel goes through the same code path, and the crash test
  covers its key.

### 2. MUST FIX: a run the start-up scan could not read lost its submit key. Fixed

- Test: "a run the start-up scan cannot read keeps its submit key; a repeat
  after it reads again replays" (same file). It appends a corrupt line to the
  log, runs `reconcile()`, restores the log, then repeats the submit.
- Seen failing first: yes (the key file was deleted).
- Fix: `pruneKeys` in `service.ts` removes the key of a run the scan did not
  return only when that run's directory does not exist.

### 3. SHOULD FIX: keys pruned only at start; temp files never removed. Fixed

- Tests:
  - `core/test/runs/idempotency.test.ts`, "the daemon prunes keys on its
    housekeeping interval, not only at start". It uses the real daemon with
    `RECLAIM_INTERVAL_MS=100`, a new knob in the test child. Seen failing
    first: yes (timed out waiting for the key to go).
  - "start-up removes temp files a crash left in the keys directory"
    (`idempotency-settle.test.ts`). Seen failing first: yes.
- Fix:
  - `StoreRunService.pruneExpiredKeys()`, called from the daemon's existing
    housekeeping `prune` timer in `daemon/main.ts` (default every 5 minutes);
  - `sweepKeyTemps`, called first in `reconcile()`, removes
    `*.tmp-<pid>-<n>` files from the keys directory.

### 4. NIT: an unreadable log released the key of an accepted cancel. Fixed

- Test: `core/test/store/idempotency.test.ts`, "a reserved steer or cancel key
  whose run log cannot be read is kept, never released".
- Seen failing first: yes. I stashed the source fix, rebuilt, ran the test,
  saw it fail, and restored the fix.
- The test exercises `recoverKeys`/`settleKey`. The `keyed` catch now calls
  the same `settleKey`, so the catch itself is covered only through that
  shared function.
- Fix: `actionOutcome` returns "unknown" for an unreadable log.

### 5. NIT, document only: earlier checks refuse a repeat of an accepted submit. Documented

- `contract/README.md`, Idempotency keys: a passed `deadline` gives `invalid`
  and an unavailable harness gives `unavailable` before the key lookup. The
  key is kept. The order of checks was not changed. No test; it is
  documentation only.

The same section and `docs/d2/part-one.md` now also state:

- the reserved-while-unknown rule;
- that an unreadable log keeps a key;
- that keys are pruned on the housekeeping interval;
- that an unreadable run keeps its key.

## Test commands and final counts

- `cd core && npm run build && npm test`. Last run: 690 tests, 677 pass,
  1 fail, 12 skipped.
  - The failure is `runs/restart.test.ts`, "a worker survives a daemon
    SIGKILL ...": timed out waiting for running, last state succeeded. It also
    fails in the full suite on the base commit `d9c16af`, which I ran in a
    separate worktree (683 tests, 670 pass, 1 fail: that same test). It passes
    3 out of 3 times when run alone. It is a load-timing failure that exists
    without this change.
  - In 2 of my 3 full runs, `publish/wiring.test.ts`, "with the broker down
    ...", also failed: "the slowest call with the broker down took 3379 ms".
    It passed in my third full run, 3 out of 3 times alone, and on base. It is
    a wall-time threshold under load; this change adds nothing to that call
    path.
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (repo root,
  after the core build): 1754 passed, 2 failed, 13 skipped.
  - `test_a_built_wheel_holds_the_schemas_byte_for_byte`: no network, not
    mine.
  - `tests/acceptance/d1/test_mock.py::test_submit_returns_a_run_id_in_under_2_seconds_and_the_task_completes`:
    the submit took longer than 2 s under `-n auto`. It fails the same way on
    base `d9c16af` (same counts there), and `test_mock.py` alone gives
    9 passed.
- `scripts/check-file-length.py`, `scripts/check-example-node.py`,
  `scripts/scan-secrets.py`: clean.

## Not run or assumed

- Not run:
  - markdownlint (not installed);
  - `scripts/check-d0-citations.py` (needs `gh`, not installed);
  - black, isort and flake8 (no Python file changed);
  - SonarCloud. Its cognitive-complexity and nesting rules were kept by hand:
    the new code is split into small helpers.
- No CLI change was needed. `post_keyed` already retries `unavailable` with the
  same key a bounded number of times, then names the key to reuse.
- Assumption: a harness-refused steer is recognized in the log by the worker's
  `run.error` whose message contains the action id. The worker writes that
  message in `worker/run-loop.ts` `steer`. If that wording ever drops the id,
  such a key would stay reserved until the run ends or its worker goes.
- The `core/node_modules` symlink was removed and not committed.
