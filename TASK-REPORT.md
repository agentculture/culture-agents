# TASK-REPORT: t4, run store schema version, 2.0 directories, startup cleanup

## Built
- `core/src/store/version.ts`: `STORE_SCHEMA_VERSION = 1`; `createRun` writes `store.json` (`{"schema":1}`) into every new run directory. A directory without it is read as schema 0 (2.0). A newer schema is refused as unreadable. `showRunAt` checks it.
- `core/src/store/entries.ts`: `listRunEntries` returns readable runs plus `{kind:"unreadable", id, detail}` entries, never dropped. `activeRuns` counts only readable active runs, which is what a limit must use.
- `core/src/store/startup.ts`: `cleanupStore` removes run directories with no complete first event and `*.tmp-<pid>-<n>` files. A directory with a live worker or unreadable liveness is left alone. It is called from `core/src/daemon/main.ts` after the state lock and before the service is created.
- Fixture: `core/test/store/fixtures/state-2.0/`, one finished run from the unmodified 0.15.3 core with the fake (stub) driver. `worker.log` is gitignored, so it is not committed.
- `docs/d2/upgrade.md`.
- Tests: `core/test/store/versioned.test.ts` (4 tests).

## Commands and results
- `cd core && npm test`: 563 pass, 0 fail.
- `npm run lint`: clean. `npm run typecheck` and `npm run check:contract-types`: ran, no errors.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1606 passed, 9 skipped, 1 failed. The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`. It needs to download hatchling from PyPI and the sandbox has no network. It is unrelated to this change.

## Acceptance criteria
1. Proven: "a directory written by 3.0 carries the store schema version" and "a run directory written by the 2.0 core is listed with its true state" (`succeeded`, terminal, cursor 4).
2. Proven at the store level: "an unreadable run is listed with its id, is not active, and its worker is not signalled". It covers a corrupt log, a newer schema and a corrupt record. It uses a live child process as the worker and checks the process was not signalled.
3. Proven: "startup removes run directories without a first event and temporary files, and keeps one with an event". Also covers a torn first line and that the 2.0 run is kept.
4. Proven by a committed record: `docs/d2/upgrade.md`.

## Assumptions and gaps
- "Listed as unreadable" is implemented in the store (`listRunEntries`). The wire contract has no unreadable shape, so `service.listRuns` and the HTTP listing are unchanged and still skip an unreadable run with a warning. Surfacing it on the wire needs a contract change, which I left out of scope. The existing busy-repository check (`unreadableRunHolding`) is unchanged; t8 removes it.
- Nothing is wired into a concurrency limit yet (t8). `activeRuns` is the function it must use.
- The cleanup removes a directory with no complete first line (including a torn line). It does not detect a live 2.0 worker mid-submit beyond the liveness check.
- A test that starts a full 3.0 daemon on a state directory with active 2.0 workers was not written. The fixture holds only a finished run. Cleanup is tested at the function level; the daemon wiring is not covered by its own test.
- The fixture's record holds absolute temp paths from the machine that made it. They are never followed.

## Left unchanged on purpose
`scan.ts`, `service.ts`, the contract, `.claude/skills`, `.devague` and `spikes`. No existing test was changed.
