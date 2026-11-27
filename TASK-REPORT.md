# Task report: review fixes for operator questions (PR 15)

All tests are in `core/test/worker/questions-fixes.test.ts`. Each was run against the unfixed code first and failed (all three failed; the third only after I added test-driver support, see below).

## 1. Hung `driver.answer` suspends both clocks: fixed
- Test: "a hung delivery does not suspend the question limit: 100 hours on, the run ends unanswered". Seen failing first: yes.
- Test: "a delivery that does not settle in time fails: the question is pending again, a run.error is logged, no run.answer". Seen failing first: yes.
- Fix: delivery is bounded by `answerTimeoutMs` (worker option, default 30 s, `ANSWER_TIMEOUT_MS` in `worker/answer.ts`). When it passes, the answer was not delivered, so no `run.answer` is written. The worker logs a non-fatal `run.error`, the caller gets `unavailable` (retryable), and the question is pending again. `QuestionDesk.due()` no longer skips a question in delivery, so it counts toward its own limit. The 50 ms re-arm no longer applies. The 12 hour limit cannot be exceeded by a slow or hung delivery.
- Residual: a harness that takes the answer after the timeout has still received it, but it is not recorded.

## 2. A harness cannot withdraw a question: fixed
- Test: "a question the harness withdraws leaves the pending set and the deadline resumes". Seen failing first: yes. It failed on the unfixed code because the driver event did not exist and the question stayed pending.
- Fix: new driver event `{type:"withdraw", ref}`. The worker logs it, the desk drops the question, and the deadline resumes when none is left. A late answer is refused, and a delivery that finishes after the withdrawal is not recorded.
- **No event kind of the 3.0 contract fits, so contract/*.json is unchanged.** The withdrawal is a diagnostic `run.output` line, `question withdrawn: <question id>` (`WITHDRAWN_PREFIX` in `store/questions.ts`). `questionLedger` and `pendingQuestions` read it back, so the question stays out of `pending_questions`. `runs/answer.ts` refuses an answer to it with `conflict`.
- Caveat: because it is a plain output line, a harness could also forge it, but it could already withdraw through the event.
- Test driver additions: a `withdraw` step, `ask` with `wait: false`, and the `answerHangs` option.
- Moved into the new `worker/asking.ts` (`run-loop.ts` is now 397 lines).
- Note: for a withdrawn question the worker's own reply is `not_found`; the core's pre-check replies `conflict`.

## 3. Question limit and `succeeded`: documented
- `contract/README.md` now says that if the harness completes during the stop a question limit started, the run ends `succeeded`. I also documented the delivery bound and withdrawal there. No test, since it is a document-only change.

## Commands and counts
- `cd core && npm run build && npm test`: 686 tests, 672 pass, 2 fail. Both failures fail the same way without my changes, in this sandbox: "with the broker down…" (466) and "a worker survives a daemon SIGKILL…" (513). Both pass when run alone. In one earlier full run, test 504 (the known finding 19 flake) also failed; it passed in the other.
- `npm run lint`, `npm run typecheck` and `npm run check:contract-types`: clean.
- Python: `python -m pytest -n auto` gave 1754 passed, 13 skipped, 2 failed. One is the known wheel test (no network). The other is `test_submit_returns_a_run_id_in_under_2_seconds…`, a timing test that passes when run alone.
- `scripts/check-file-length.py`, `check-example-node.py` and `scan-secrets.py`: clean.
- Not run: flake8, black and isort (no Python files were changed). The `core/node_modules` symlink was removed.
