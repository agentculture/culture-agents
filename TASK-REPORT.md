# Task report: pr-15 review, finding 19 (a `succeeded` run with `branch: null`)

## Cause (found and reproduced)

The commits were collected. The bug is in how the run is read back.

- The worker finishes a run with collected commits in this order (`core/src/worker/run-loop.ts`
  `recordCollected`): it writes `collected.json`, then the run record with `branch`, then it
  appends the terminal `succeeded` event.
- The reader (`core/src/store/run-store.ts` `showRunAt`) read the record first and the log after.
  A read whose record read came before the worker's record write, and whose log read came after
  the terminal event, derived `succeeded` with `branch: null` (`deriveRun` takes `branch` from the
  record and the state from the log).
- That read then wrote `summary.json`. The summary is keyed on the log's byte size, and the terminal
  event is the log's last write, so every later read, including `GET /v1/runs/<id>/result`, served
  the branchless run for good. The record on disk held the branch and `runs/<id>` held the commits.
- The test's `waitRun` polls the run every few milliseconds, so under load a poll sometimes lands
  in that window (two durable writes, each with an fsync).

Ruled out by reading the collection path:
- Stub fetch errors are not swallowed: `git()` throws, and the driver fails the run.
- The temporary clones are separate `mkdtemp` directories, and the branch names are separate run ids.
- The fetch locks only `runs/<id>` (see docs/d2/concurrent-fetch.md).
- `shas` is computed after the fetch has completed.

## Reproduction

- **End to end, on the old build:** `/tmp/stress.sh` (not committed) runs only the isolation test
  ("2 runs in 1 repository ...") 200 times in a row on a 12-CPU sandbox, with 24 busy-loop
  processes competing for the CPU. It failed **2 times in 200** (iterations 29 and 48), each with
  `expected 'runs/<id>'`, `actual null`, which is the merge-host symptom. On the fixed build, the
  same 200 iterations under the same load gave **0 failures**.
- **Deterministic:** `core/test/store/record-race.test.ts` uses the `readFile` hook to run the
  worker's completion writes between the reader's record read and its log read. It fails on every
  run on the old code.
- A one-off check against the old build (not committed) showed that the next plain read also
  reported `branch: null` (from the cached summary), while the record on disk held the branch.

## Findings

1. **Record read before the log: `succeeded` without its branch, cached for good. FIXED.**
   - Test: `core/test/store/record-race.test.ts`, "a run read while its worker completes it
     reports succeeded only with its branch, and caches no run without it". Seen failing first:
     **yes** (actual `null`).
   - Fix: `showRunAt` reads the record again after the log (and again after settling an orphan).
     The trace follower already used this order.
2. **Summaries already written with the bug would be served for ever. FIXED.**
   - Test: same file, "a branchless summary written before the fix is not served: ...". Seen
     failing first: **yes**.
   - Fix: `SUMMARY_VERSION` goes from 1 to 2 (`core/src/store/summary.ts`). Each finished run's
     summary is rebuilt once from its log, as the README's cache rule describes.
3. **Sandbox path: a failed commit count read as "nothing to collect". FIXED.** This was found while
   reading the path and is not the cause of the flake.
   - `SandboxWorkspace.commitCount` returned 0 when the count command failed, so `collect()`
     returned null and the run succeeded with no branch, although `commitAll` had counted commits.
   - Tests:
     - `core/test/harness/workspace.test.ts`, "a commit count that fails in the sandbox fails
       the collect; it is not read as nothing to collect". Seen failing first: **yes** (missing
       rejection).
     - `core/test/harness/retention.test.ts`, "a turn that committed work whose collect brings
       back nothing fails and keeps the sandbox, never succeeds without its branch". Seen failing
       first: **yes** (the outcome was `completed`).
   - Fix:
     - The count failure now throws.
     - `RunDriver.commitAndCollect` treats committed work with a null collect result as a failed
       collect. That path fails the run and keeps the sandbox under the existing retention rule.

No document needed a change. The README already says that the summary is a cache of the derived
record and that a failed collect keeps the sandbox. The fixes bring the code in line with both.

## Commands and final counts

- `cd core && npm test` (build + all tests): 687 tests, 675 pass, 0 fail, 12 skipped (the suite's
  own opt-ins).
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (repo root, after the core build):
  1755 passed, 1 failed, 13 skipped. The failure is
  `test_a_built_wheel_holds_the_schemas_byte_for_byte` (no network here), which is not mine.
- `scripts/check-file-length.py`, `scripts/check-example-node.py`, `scripts/scan-secrets.py`: clean.
- No Python file changed, so black, isort and flake8 were not run.
- Not run: markdownlint (not installed); the sandbox path against a real OpenShell gateway.
- `core/node_modules` symlink removed.
