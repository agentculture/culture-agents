# Task report: TypeScript static-analysis findings (D2 part one)

All 38 TypeScript findings were addressed. None was left open, and none was suppressed or marked
accepted. Behaviour, log text, error messages and exports are unchanged. One new module was added:
`core/src/runs/submit.ts`, because `service.ts` was at the 400-line limit. No test or assertion was
removed or weakened.

There is no SonarQube analyser in this sandbox, so the cognitive-complexity figures below are my
own count using Sonar's rules. Only the next analysis can confirm them.

## Findings

| Finding | Status | What changed |
|---|---|---|
| daemon/main.ts:136 S3776 | fixed | `serveUntilStopped` now calls named steps: `readOperatorLimits`, `claimStore` (lock, then the store sweep), `builtInRuns`, `startOrReport`, `reconcileRuns`, `startHousekeeping` (returns a function that clears the timers) and `finishAfterFatal`. The order of every step, log line and exit code is the same. |
| harness/stub/backend.ts:122 S6582 | fixed | `this.asked?.ref !== ref` |
| harness/stub/backend.ts:42 S7780 | fixed | ``String.raw`^\s*${key}:\s*(.+)$` `` builds the same pattern. |
| publish/log-tail.ts:107 S3776 | fixed | `openLog` and `readChunk` (the inner line loop) were split out of `readFrom`. |
| publish/publisher.ts:169 S3358 | fixed | `waitAfter(count)` |
| publish/publisher.ts:170 S9382 | fixed | The follow loop is now `round()` (one pass, then the sleep), which `follow()` chains with `round().then(next, reject)`. A round starts only after the one before has finished, so rounds are still sequential. I avoided an async recursive step because it would build an endless promise chain in a long-running daemon. |
| publish/publisher.ts:91 S3776 | fixed | `pendingOf`, `messageFor`, `offer`, `record` and `publishItem` were split out. The position is still recorded only after the broker acknowledges: in memory first, then on disk. |
| runs/branches.ts:86, 87, 103 S9382 | fixed | `listBranches` folds the lines with a reducer over the async helper `branchOf`. `removeBranches` chains `settleBranch` with `before.then(...)`. Branches are still handled one at a time and in order, with one git command at a time, and the first failure still stops the rest. |
| runs/branches.ts:97 S3735 | fixed | `skip` now has a block body. |
| runs/gateway.ts:60 S3776 | fixed | The redirect check moved to `redirectTarget`. |
| runs/keys.ts:64 S6582 | fixed | `!entry?.action` (`action` is `ActionRecord \| null`). |
| runs/reattach.ts:11, 12 S3863 | fixed | The two imports are now one. |
| runs/service.ts:106 S3735 | fixed | The default `warn` has a block body. |
| runs/service.ts:154 S3776 | fixed | Steps 4–5 (`submittableHarness`), the run record (`newRunRecord`) and the spawn with its key settlement on failure (`startWorker`) moved to the new `runs/submit.ts`. `submitNow` still writes the key, then calls the `after-key` fault, then creates the run directory (`after-run-dir`) and spawns, then sets the control, calls `after-spawn` and establishes the key. `service.ts` is now 352 lines. |
| store/idempotency.ts:45 S3358 | fixed | `byCodeUnit(a, b)`. This is deliberately not `localeCompare`: request digests depend on code-unit order. |
| store/idempotency.ts:46 S4624 | fixed | The member list is built before the outer template. |
| store/idempotency.ts:58 S3735 | fixed | Copy, then `Reflect.deleteProperty(rest, "idempotency_key")`. This gives the same body as before, and key order does not matter because `canonical` sorts. |
| trace/config.ts:55 S8786 | fixed | `withoutTrailingSlashes` is a single loop from the end of the string, so there is no regex left to backtrack. I checked it against the old `/\/+$/` replace on edge cases (`""`, `/`, `//`, `/a//b///`, …). |
| trace/config.ts:56 S4624 | fixed | `basicAuthorization(pub, second)` builds the credentials before the header. |
| trace/follower.ts:119 S2871 | fixed | `.sort((a, b) => a.localeCompare(b))`. The sorted keys only make up the fleet signature, which is compared for equality. No test depends on their order (`trace.test.ts` checks the gauge spans, which come from `counts.values()`). |
| trace/follower.ts:169 S3358, S9382 | fixed | Same `waitAfter` / `round` / `follow` structure as the publisher. The cursor is still written only after a successful send (`traceRun` is unchanged). |
| trace/spans.ts:103 S7778 | fixed | The two pushes are now one call (`make` is pure, so evaluation order makes no difference). |
| trace/spans.ts:32 S3776 | fixed | `spanMaker`, `closeTool`, `questionSpan`, `onState`, `onWork` and `onTerminal` work over a `Builder` and a `Walk`. Spans are pushed in the same order. |
| worker/control.ts:49 S3776 | fixed | `actionRequest` and `cancelRequest` were split out of `parseRequest`. |
| worker/fake-driver.ts:73 S7503 | fixed | `answer` callers expect a promise, so `takeAnswer` drops `async` and returns `Promise.reject(...)` / `Promise.resolve()` explicitly. Failures are still rejections. |
| test/daemon/secrets-child.ts:25 S7503 | fixed | The fake `exec` returns `Promise.resolve(...)`. |
| test/publish/broker.ts:95, 124 S3735 | fixed | Both now have block bodies. |
| test/publish/broker.ts:130–139 S2004 | fixed | `subscribeTo` and `subscriberOf` were moved out of `startBroker`. |
| test/publish/support.ts:55 S3735 | fixed | `loose` has a block body. |
| test/runs/support.ts:249 S4036 | fixed | git runs with `{ ...hostEnv(), PATH: "/usr/bin:/bin" }`. |

### Things the next analysis might still raise

- **Await in the publisher's loop:** `publisher.ts` still awaits `publishItem` inside its `for…of` loop. An early `return` that depends on the result of that await follows it in the loop. The analyser did not flag the same pattern elsewhere (`mergedInto` in `branches.ts`, `fetchStatus` in `gateway.ts`, the original `pass` loops), so I expect it to accept this one. The loop has to stay sequential: events go out in cursor order.
- **Unlisted `void` uses:** `service.ts:121` (`void this.reattacher.begin`) and the two in `main.ts`'s stop-wait promise were not in the list, so I left them alone.

## Commands and final results

Run with `core/node_modules` symlinked to `/usr/local/share/dogfood/core/node_modules`. The symlink has been removed.

- `cd core && npm test`: 683 tests, 671 pass, 0 fail, 12 skipped. This is the same as the baseline taken before any change.
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm run check:contract-types`: exit 0.
- From the repository root, `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1755 passed, 13 skipped, 1 failed. The failure is `test_a_built_wheel_holds_the_schemas_byte_for_byte`, which needs the network (known, not from this change).
- `scripts/check-file-length.py`: all 304 files within 400 lines.
- `scripts/check-example-node.py`: clean.
- `scripts/scan-secrets.py`: clean.

## Not run

- black, isort and flake8: no Python file was changed.
- The SonarQube analysis itself: it is not available in this sandbox.
- The 12 skipped core tests skip themselves as NOT VERIFIED in this sandbox: 4 need a local broker (no container runtime here), 6 are opt-in live harness turns and 2 need `OPENSHELL_LOCAL_TLS_DIR`. So `test/publish/broker.ts` was compiled and linted, but its broker-backed tests did not run here.
