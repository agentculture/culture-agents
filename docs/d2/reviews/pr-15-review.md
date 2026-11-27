# PR #15 review — D2 part one: recovery and concurrency on a single host (API 3.0)

Verdict: request-changes (at c47d690, 487 files, +18829 −1164, reviewed 2026-11-27)

The web diff and the local branch agree at c47d690. Tests at the tip, run by the reviewer: core 683 tests, 675 passed, 0 failed, 8 skipped; Python 1756 passed, 13 skipped. The suites are green and still miss the six defects below, each reproduced by running code against core/dist.

## 1. Correctness findings

Must fix (all reproduced):

1. core/src/runs/service.ts:314-320 and core/src/store/idempotency.ts:196-203 — a steer slower than the 8 s steer timeout is answered `unavailable` and its key is released, because the worker writes `run.control` only after the harness took the steer. The CLI's `post_keyed` retries `unavailable` with the same key, so one `agents runs steer` can deliver the steer twice. Probe: 3 sends, 2 deliveries, 2 `run.control` records.
2. core/src/runs/service.ts:127-133 (`pruneKeys`) — at start, a run the scan cannot read counts as "left the store", so its established submit key is deleted. A repeat of that submit then creates a second run. Probe: one EIO during `reconcile()`, then 2 runs for 1 key.
3. core/src/runs/reattach.ts:39,61 and core/src/runs/scan.ts:58-59 — one missed ping at restart makes a live run read `unknown`, `terminal: true` for the daemon's lifetime; the attempt is never retried. Cancel and answer are refused `conflict`, the run stops counting against limits, and the state later changes to `succeeded`. This breaks "a terminal state is final" and the README's "a worker that is alive is never reported as unknown".
4. core/src/store/run-store.ts:85-86 — `readSummary` runs before `assertReadableVersion`, so a run directory written by a newer store version with a summary is listed as a normal finished run, and retention deletes it.
5. core/src/store/startup.ts:49-65 — start-up cleanup ignores the store version: a newer-version directory without `events.jsonl` is removed.
6. core/src/store/summary.ts:31-41 — a summary is trusted when `log_bytes` matches. Its `run.id` is not compared with the directory, and an edited summary changed the listed state and made retention delete the run.

Should fix:

1. core/src/runs/scan.ts:59 — the `unknown` overlay keeps `pending_questions`, which fails the `run` schema (maxItems 0 on a terminal run); reproduced with `validate("run")`.
2. core/src/runs/branches.ts:62 — `otherRefs` excludes local run branches but not `refs/remotes/*/runs/`. A pushed, unmerged run branch is deleted with its own remote-tracking ref as the evidence. Reproduced in a scratch repository.
3. core/src/daemon/secrets.ts:31 — deleting from `process.env` does not change `/proc/<pid>/environ`; a same-user process can still read the secrets. "Nothing inherits" holds; "removed" does not. Reproduced.
4. core/src/runs/gateway.ts:74-75 — the body is read whole before the size check; an endless `/status` response grew the process by about 1.2 GiB inside the 1 s limit. Reproduced.
5. core/src/runs/gateway.ts:62 and `hostView` — the first hop is not held to loopback, only redirects are. Reproduced with an injected fetch.
6. core/src/daemon/main.ts:194-196 and core/src/sandbox/host-command.ts:31-41 — trace keys are loaded after the socket listens, and `hostEnv` does not filter `CULTURE_AGENTS_TRACE_*`, so a host git command in that window inherits them. The filter gap is reproduced; the window is read only.
7. core/src/worker/answer.ts:46 and core/src/worker/questions.ts:137 — a hung `driver.answer` suspends both the question limit and the run deadline; delivery has no timeout. Reproduced with the clock advanced 100 hours.
8. core/src/store/retention.ts:62 — retention removes `timed_out` and `unanswered` runs; contract/README.md says only `succeeded`, `failed` and `cancelled`. Reproduced.
9. core/src/store/retention.ts:41-51 against core/src/worker/retained.ts:25 — two readers of `retained.json` disagree on a damaged record; retention prunes what `readRetained` would keep 7 days. Reproduced.
10. core/src/store/startup.ts:42 — `sweepTemps` follows a symlinked run directory and deleted a temp-named file outside the state directory. Reproduced.
11. culture_agents/cli/_render.py:199-214 — text mode prints nothing for `run.question`, `run.answer` or `pending_questions`, while the hints say `runs show` lists the questions. A question id is reachable only with `--json`. Reproduced.
12. Keys are pruned only at start, so `keys/` grows for the daemon's lifetime (the CLI generates a key on every call). Read only.

Nits: `agents explain runs` says "`answer` is not a verb yet"; a repeat of an accepted submit after its deadline gets `invalid` before the key lookup; the question limit can end in `succeeded` when the harness completes during the stop; a harness cannot withdraw a question.

## 2. PR-text vs tip divergences

- The description gives core 661 tests / 653 passed and Python 1694 passed; the tip measures 683 / 675 and 1756.
- It lists the gateway read and the two contract additions as "in progress"; both are merged (t31, t30).
- contract/README.md marks `submitter`, `retry_after_ms` and reattach as planned although the code produces them, and never mentions `branches.list`, `branches.remove` or `branches.json`.
- docs/d2/upgrade.md says an unreadable run directory is listed; the scan skips it, as docs/d2/part-one.md says.

## 3. Compat/API notes for callers

- The `busy` refusal is removed; a caller that matched on it now sees concurrent runs or `limit_reached`.
- A submit against a repository with no resolvable commit is refused `invalid`.
- The core refuses to start when a socket directory set through `CULTURE_AGENTS_SOCKET` is reachable by other users.
- A non-loopback `CULTURE_AGENTS_TRACE_ENDPOINT` stops the core at start.

## 4. Test coverage

Covered well: key replay and conflict across a restart and three kill points; question durability, single answer and the paused deadline with an injected clock; limits; branch removal against real git; pid reuse.
Gaps: no test for a steer slower than its timeout, an unreadable run at start, a missed ping at reattach, a newer-version store with a summary, or a hung answer delivery. Those five gaps are where the must-fix defects are.

## 5. Security/robustness notes

Sound, checked by running: loopback parsing over 21 URL forms; the socket is bound under umask 0177 in an `lstat`-checked 0700 directory; the submitter comes only from the socket owner; git arguments are `-C <realpath>` and `branch -d --` with run-id-shaped names; workers and sandboxes do not inherit secrets or trace keys; with content off, spans carry ids, names and states only.

## Measured / merely seen / never verified

- Measured by the reviewer: the diff identity at c47d690; both suites at the tip; reruns of the probes for findings 1, 2 and 3; the cited lines for findings 2, 4 and 8.
- Measured by a delegated reviewer and not rerun by the orchestrator: findings 5 to 17.
- Read only: findings 12 (window) and 18, and the nits.
- Never verified: the SonarCloud gate (78 open findings at review time, clean-up in progress), a live trace to a real Langfuse, the OpenCode live acceptance check, an `admit` or `hold` from a real gateway, and a 12 hour question hold.

## Added after the review (2026-11-27, at the merge gate)

19. Should fix, seen once, not reproduced. core/test/runs/isolation.test.ts, "2 runs in 1 repository complete": in 1 of about 8 full-suite runs on the merge host, one of the 2 runs ended `succeeded` with `branch: null` in its result, so its commits were not on a `runs/<id>` branch. The test passed in 12 standalone runs and 5 further full-suite runs. Either collection can lose a run's commits when 2 runs collect into 1 repository under load, or the stub driver wrote nothing; which was not determined. Until it is, the claim that concurrent runs each return their own commits rests on a test that has failed once.
20. CI flake, mitigated, cause not proven. The `test` job failed twice with "Could not report code coverage ... JSON at position 524288": a coverage file cut off at 512 KiB. The likely cause is a test helper killing a worker while it writes its coverage file on exit. The helpers now wait up to 400 ms for such a process to finish in a coverage run (`letExitForCoverage` in core/test/worker/helpers.ts). If the error returns, this was not the cause.
