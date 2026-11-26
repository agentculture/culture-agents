# TASK-REPORT: t5, run store retention and constant-cost reads

## Built
- `core/src/store/summary.ts`: `summary.json` per finished run (derived run + byte size of `events.jsonl`). A cache: a missing, invalid, non-terminal or stale (size differs) summary is ignored and rebuilt from the log. `showRunAt` reads it first and writes it after deriving a terminal, non-orphaned run.
- `core/src/store/retention.ts`: `pruneFinishedRuns` and `retentionFromEnv` (`CULTURE_AGENTS_RUN_RETENTION_DAYS`, default 30; `0`/`off`/unusable disables). Wired into the daemon at startup and on the reclaim interval (`core/src/daemon/main.ts`).
- Injected reader: optional `readFile` on `readLog`, `ShowOptions`, `ScanOptions` and `RunServiceOptions`.
- `contract/README.md`: new section "Retention of finished runs".
- Tests: `core/test/store/retention.test.ts` (4 tests). No existing test was changed or deleted.

## Commands and results
- `cd core && npm run build && npm test`: tests 585, pass 573, fail 0, skipped 12.
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto -q`: 1606 passed, 9 skipped, 1 failed. The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`: `uv build` needs hatchling from pypi.org, and the sandbox has no network. It fails the same way with my changes stashed.

## Acceptance
1. Proven: "with 500 finished runs on disk, submit, list and attach..." counts opens of `events.jsonl` through the injected reader. Submit read at most 3 logs and list plus attach at most 4. These are the new run's own log, never one of the 500.
2. Proven for the rule, partly for the wiring. The rule is in `contract/README.md`. The test "retention removes a finished run only after the period..." covers the period, a retained sandbox (the period runs from the end of the retention), unknown state, an unreadable log, and retention off. The daemon wiring is not covered by a test; it is untested glue.
3. Proven: "a deleted summary gives the same listing..." deletes it, gets the identical listing, and shows a stale or corrupt summary is ignored.

## Assumptions and not measured
- A finished run's summary is written the first time it is read, not when it ends. The 500-run test warms it with one `listRuns` call. A store with no summaries pays one log read per finished run once.
- Cost is "no event-log reads", not strictly constant: each finished run still costs a stat and a summary read per scan. No separate index file was built.
- A live worker keeps its directory. An unreadable `retained.json` counts as retained for 7 days from its file time (mirrors `readRetained`; I did not import it).
- The prune runs on the reclaim timer and is independent of sandbox reclaim. A sandbox whose reclaim kept failing for the whole retention period would lose its run directory, and the reclaim could no longer find it.
- The live stage was not run.

## Left unchanged on purpose
`core/src/store/entries.ts` and `startup.ts`; they pick the summary up through `showRunAt`. The openshell-RESOLVE-PLACEHOLDER lines were not touched.
