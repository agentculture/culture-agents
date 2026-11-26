# TASK-REPORT: t9 reattach to surviving workers

## Built
- `core/src/runs/reattach.ts`: `Reattacher`, one reattach attempt per run through `reconnectWorker`; an answering worker's `WorkerControl` goes back into the service's controls map. A live worker whose socket does not answer is recorded as unresponsive.
- `service.ts`: `reconcile()` starts an attempt for every non-terminal run. `act()` (steer/cancel) waits for the run's attempt (`reattachWaitMs`, default 5000), then answers `unavailable` with `retry_after_ms` and `run_id` if it is still open. The attempt also starts lazily, so the listen-before-reconcile gap in `daemon/main.ts` cannot produce a refusal. New options `reattachWaitMs` and `reconnect` (test hook).
- `scan.ts`: an unresponsive live worker's run is reported `unknown` (terminal, `live_control: false`), nothing is appended to its log and the worker is never signalled.
- `control.ts`: step 7 no longer says `unsupported reconnect`; a missing channel is `unavailable` + `retry_after_ms`.
- `harness/common/capabilities.ts`: `reconnect` is now reported supported for every harness.
- `docs/d2/reattach-overlap.md`: finding on the parked dying-core question (from code reading; not measured).
- Worker control-socket protocol untouched (`worker/control.ts` not edited).

## Commands run (in core/, node_modules symlink removed afterwards)
- `npm test` (builds first): tests 530, pass 522, fail 0 (the remaining 8 are skips reported by the runner).
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: all clean.
- NOT run: the Python suite (`pytest`), and the acceptance suite in `tests/acceptance`. No Python file was touched.

## Acceptance
1. Proven: `test/runs/reattach.test.ts` "after a restart with 2 live workers..." (steer each, cancel one, attach, reconnect supported via `/v1/harnesses/fake`); also `restart.test.ts`. Capability for the real registry: `test/harness/registry.test.ts`.
2. Proven: "a control request before the reattach attempt finished..." holds `reconnect` open: `unavailable` with `retry_after_ms`+`run_id`, then a request issued while held succeeds once released.
3. Proven: "a worker whose control socket does not answer..." (socket file removed, worker alive): `unknown`, pid still alive, steer refused as conflict; terminal run's reconnect never called, cancel is conflict.
4. Proven: "SIGKILL of the core signals no worker..." (worker survives, writes `cancelling`/`timed_out` with no core). "Sends no signal" is shown by the worker surviving, not by tracing signals. Protocol tests untouched.

## Choices and caveats
- "Reported unknown" for a silent live worker is an overlay on reads, not an appended event (the worker may still write). Side effect: unknown is terminal, so that repository is no longer busy while the worker lives. Not tested.
- A failed attempt is not retried (except when liveness itself could not be read).
- Existing tests changed because behaviour changed: `restart.test.ts` (two tests now expect reattached control), `registry.test.ts` and `contract-suite.ts` (7 undeclared capabilities instead of 8), `test/runs/child.ts` (fake declares reconnect supported).
- Not done: two competing actions from an old and new core have no ordering rule (see the docs note). The contract README's "planned" wording for t9 was not edited.
