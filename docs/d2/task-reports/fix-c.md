# TASK-REPORT: run-store fixes from the review of pull request 15

Scope: the run-store findings of `docs/d2/reviews/pr-15-review.md` (must fix 4, 5, 6; should fix
8, 9, 10) and the upgrade.md correction. All new tests are in
`core/test/store/store-review.test.ts`. Every one of them was built and run against the unchanged
code first, and each failed there for the reason the finding describes. Then the fix went in.

## Findings

1. **The version check comes first (MUST FIX). Fixed.** `showRunAt` now calls
   `assertReadableVersion` before anything else, the summary included. A newer-version directory
   is unreadable. The listing reports it as unreadable and retention keeps it.
   Test: `a newer-version directory with a summary is unreadable, and retention keeps it`.
   Seen failing first: yes (it was listed as `succeeded`).

2. **Start-up cleanup ignores the store version (MUST FIX). Fixed.** `cleanupStore` checks the
   version of each run directory before liveness, the event check or the temp sweep. A newer schema,
   or a version file that is not a version, gets a warning and the directory is left alone.
   Test: `start-up cleanup modifies nothing inside a newer-version directory`. It covers a directory
   with no `events.jsonl` and a temp-named file. Seen failing first: yes (the directory was removed).

3. **Summary trusted on `log_bytes` (MUST FIX). Fixed.** The summary is now version 2 and is
   believed only when all of these hold:
   - its `run.id` equals the directory name;
   - the log digest matches: size, inode, mtime and ctime in nanoseconds, and the SHA-256 of the
     final 4 KiB;
   - the log's last complete line is the terminal `run.state` event the summary reports: run id,
     cursor, state, reason, and `ended_at`/`updated_at` time.

   Why this digest: the log is append-only, and a finished run's log is never written again. Any
   write changes the size or the times. An edit that keeps the size and resets mtime still moves
   ctime, which only the kernel sets. The tail hash catches a rewrite of the end at the same size
   within one timestamp tick. All of it costs one `stat` plus one read of at most 4 KiB, with no
   parsing of the whole log. The tail check also means a summary edited to another state or end
   time is rejected even when its digest fields were copied unchanged.

   Retention never decides from the cache alone. The cached read only picks candidates. Before a
   delete, `removable` re-derives the run with `showRunAt(dir, { fromLog: true })`, a new option,
   and applies the rule again.
   Tests, all seen failing first: yes:
   - `a summary naming another run is not believed`
   - `an edited summary changes neither the listing nor what retention removes`
   - `retention re-derives a run from its log before deleting it, even with a current summary`
   - `a log corrupted at the same size is not listed from the summary` (end line, and a middle line)

   What remains (stated in the `summary.ts` header): a same-size rewrite of an earlier line, made
   within the same timestamp tick as the summary write, could still be listed from the cache.
   Retention is not affected, because it reads the log.

4. **Retention of `timed_out` / `unanswered` (SHOULD FIX). Fixed by changing the documents, not
   the code.** The spec (`docs/specs/2026-11-25-d2-fleet-and-recovery.md`) says only that
   "finished runs' directories have a retention rule" and that finished runs must stop
   accumulating. `timed_out` and `unanswered` are known, final, worker-written terminal states;
   only `unknown` is a view. So the code stays as it was, and these now name all five states:
   - the rule in `contract/README.md`, "Retention of finished runs";
   - the `retention.ts` header.

   The README also now says that a newer-schema directory is never removed, that a damaged
   `retained.json` keeps a run 7 days, that the decision is taken on the log, and what the summary
   digest holds.
   Test: `retention removes every known finished state, and the documents name each one`. It pins
   the code behaviour and checks that both documents name each state. Seen failing first: yes. The
   README assertion failed. The code part (removal of `timed_out`/`unanswered`) passed on the old
   code too, as expected.

5. **Two readers of `retained.json` (SHOULD FIX). Fixed.** `retention.ts` now reads the record
   through `readRetained` (`core/src/worker/retained.ts`). `{"until": 0}` and a record without
   `sandbox` count as damaged and keep the run 7 days from the file time.
   Test: `a damaged retained.json keeps the run, as readRetained reads it`.
   Seen failing first: yes (both runs were pruned).

6. **`sweepTemps` follows symlinks / EISDIR aborts the sweep (SHOULD FIX). Fixed.**
   - A run entry is `lstat`ed. Anything that is not a real directory, a symlink included, is
     reported and never followed.
   - Only regular temp-named files are removed. Anything else is reported and kept.
   - Each entry has its own try/catch, so one bad entry never stops the sweep.

   Tests, seen failing first: yes for both:
   - `start-up cleanup never follows a symlinked run directory out of the store` (the outside file
     was deleted)
   - `a temp-named directory does not stop the sweep` (threw EISDIR)

**docs/d2/upgrade.md.** The section "A run directory the core cannot read" now says such a
directory is skipped by the listing and not shown over the API. The core logs a warning with its id
(checked in `core/src/runs/scan.ts:64`). Step 1 and procedure step 4 were changed to match. This is
a document correction and has no test.

## Commands and final counts

From `core/`, with the `node_modules` symlink (removed afterwards):

- `npm run build && npm test`: tests 693, pass 679, fail 2, skipped 12.
  - The 2 failures are `publish/wiring.test.js` "with the broker down … no call to the core waits
    on it" (slowest call 4141 ms) and `runs/restart.test.js` "a worker survives a daemon SIGKILL…".
  - Both pass when run alone, twice.
  - Both fail the same way on the base commit d9c16af, measured in a separate worktree: 683 tests,
    669 pass, the same 2 fail. They are timing-sensitive under full-suite load and not caused by
    this change.
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: clean.
- `node --test dist/test/store/*.test.js`: 53 pass, 0 fail.

From the repository root:

- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1754 passed, 13 skipped, 2 failed.
  - `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte` fails
    for lack of network (known).
  - `tests/acceptance/d1/test_mock.py::test_submit_returns_a_run_id_in_under_2_seconds_and_the_task_completes`
    took 2.79 s against a 2.0 s limit under `-n auto`. It passes when run alone. On the base commit
    the d1 subset under `-n auto` fails it the same way (2.17 s), so it was failing before this
    change.
- `scripts/check-file-length.py`, `scripts/check-example-node.py`, `scripts/scan-secrets.py`: clean.

## Not run, assumed

- The SonarCloud analyser was not run. Functions were kept small by hand (helpers `decide`,
  `removeTemp`, `expired`, `removable`, `logEnd`, `endsAs`, `sameDigest`). There are no nested
  ternaries, no `void`, and no nested template literals.
- The tail read of a summary check opens `events.jsonl` through a file descriptor, not through the
  injected `readFile`. The 500-run test therefore still counts zero log reads for finished runs,
  although each one now costs a read of at most 4 KiB on top of the stat.
- A summary written by the previous code (version 1) is ignored once, then rebuilt from the log.
- `store/retention.ts` now imports `worker/retained.ts`, as the task directed. That module imports
  only types from `worker/driver.ts`, so there is no cycle.
- The existing test "a deleted summary gives the same listing, and a stale one is ignored" still
  edits `log_bytes`, a field the summary no longer has. It is unchanged and still passes, because
  the edited state is rejected by the new checks.
