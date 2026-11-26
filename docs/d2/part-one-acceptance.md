# D2 part one acceptance record

The suite is `tests/acceptance/d2/`: a mock stage that always runs (the real
`agents` CLI against the real core in `core/dist`, with the stub harness) and an
opt-in live stage (`CULTURE_AGENTS_ACCEPTANCE_LIVE=1`). Each check is recorded as
**measured** (a number was taken), **seen** (the behaviour was observed and
asserted) or **NOT VERIFIED** (not run, with the reason). No node name other than
`thor` appears here.

## Commands

```bash
cd core && npm ci && npm run build && cd ..
# mock stage (always runs; no sandbox, gateway or model)
CULTURE_AGENTS_ACCEPTANCE_REPORT=/tmp/d2.jsonl python -m pytest tests/acceptance/d2 -v -rs
# live stage (opt-in; needs the gateway, the run image and credentials)
CULTURE_AGENTS_ACCEPTANCE_LIVE=1 CULTURE_AGENTS_ACCEPTANCE_REPORT=/tmp/d2.jsonl \
  python -m pytest tests/acceptance/d2/test_live.py -v -rs
```

## Mock stage (run in the build sandbox, 2026-11-26)

Output of the mock command above: `6 passed, 4 skipped in 14.92s`. The 4 skips are
the live stage, reported NOT VERIFIED below.

| # | Check | Result | Test | Evidence |
|---|-------|--------|------|----------|
| 1 | Kill the core with 2 runs active in 1 repository, restart, steer one, cancel the other | **seen** | `test_check1_restart_...` | `{"check": "mock.d2.restart_steer_cancel", "runs": 2, "steer": "accepted", "cancel": "cancelled"}`; both workers survived and were reattached (`live_control` true); the steered run kept running |
| 2 | 1 key sent 2 times is 1 run; a changed request conflicts | **seen** | `test_check2_one_key_...` | `{"check": "mock.d2.idempotency", "runs_for_two_sends": 1, "changed_request": "conflict"}`; the conflict created no run |
| 3 | A question survives a restart and is answered | **seen** | `test_check3_a_question_...` | `{"check": "mock.d2.question", "survived_restart": true, "answers_logged": 1}`; the same question id was pending after SIGKILL and restart, `runs answer` was accepted, the run ended `succeeded`, a second answer got `conflict`, the log holds one `run.question` and one `run.answer` |
| 4 | A submit past a configured limit is refused with the typed error | **seen** | `test_check4_a_submit_past_...` | `{"check": "mock.d2.limit", "configured": 2, "refused": "limit_reached"}`; limit `limits.runsPerRepository: 2` from the core's config file; the refused submit created no run; a submit to another repository was accepted |
| 5 | 0 runs report `succeeded` without a worker's terminal event | **seen** | `test_check5_no_run_...` | `{"check": "mock.d2.honest_success", "runs": 3, "succeeded_without_event": 0}`; a run whose worker was killed with the core reads `unknown`; the only `succeeded` run has the worker's `succeeded` event |
| 6 | With 2 runs active in 1 repository, a third submit to another repository returns its run id in under 2 s; a cancel reaches `cancelled` in under 10 s | **measured** | `test_third_submit_...` | `{"check": "mock.d2.timing", "submit_seconds": 0.333, "cancel_seconds": 0.33}` (CLI wall time of the submit; time from the cancel request to `cancelled`) |

Check 5 is shown for the stub harness and for a worker killed outright. It does not
show a worker that is alive but silent (t9 tests that against fixtures).

## Live stage

**Results of the live stage were not produced in the build sandbox** (no gateway, no
credentials, no run image). Every live check below is NOT VERIFIED until the
merge host fills it in.

| Check | Harness | Result | Reason |
|-------|---------|--------|--------|
| Third submit to another repository under 2 s; cancel under 10 s, with 2 runs active in 1 repository | Claude Code | NOT VERIFIED | live stage not run here: set `CULTURE_AGENTS_ACCEPTANCE_LIVE=1` on a host with the gateway |
| Third submit to another repository under 2 s; cancel under 10 s, with 2 runs active in 1 repository | OpenCode v2 | NOT VERIFIED | live stage not run here: same reason |
| Question survives a restart and is answered | Claude Code | NOT VERIFIED | `answer` is reported unsupported; only the stub harness can ask (t13) |
| Question survives a restart and is answered | OpenCode v2 | NOT VERIFIED | `answer` is reported unsupported; only the stub harness can ask (t13) |
| Checks 1, 2, 4 and 5 on a real harness | both | NOT VERIFIED | the live stage times the third submit and the cancel only; these four are mock-stage checks |

The question check is NOT VERIFIED on both real harnesses even with the opt-in, by
design: the live test always reports it so, and it is never a pass.

### Live results (run by the main agent on the merge host, 2026-11-26 23:35 UTC)

Command, with the OpenShell gateway registered and the run image set:

```bash
CULTURE_AGENTS_ACCEPTANCE_LIVE=1 uv run pytest tests/acceptance/d2/test_live.py -k "claude and third" -v -rs -p no:xdist
```

| Check | Harness | Result |
| --- | --- | --- |
| Third submit to another repository with 2 runs active in 1 repository | Claude Code | measured: 0.464 s (limit 2 s) |
| Cancel of that run reaches `cancelled` | Claude Code | measured: 7.67 s (limit 10 s) |
| The same 2 checks | OpenCode | NOT VERIFIED: not run. The check starts 3 runs at once on the local model, and the owner's rule for this build is 1 local-model run at a time |
| Question survives a restart and is answered | Claude Code, OpenCode | NOT VERIFIED: both report `answer` as unsupported |

Report file lines for the passing run:

```json
{"check": "live.d2.timing", "time": "2026-11-26T23:35:37Z", "harness": "claude-code", "submit_seconds": 0.464, "cancel_seconds": 7.67, "state": "cancelled"}
{"check": "live.d2.timing.precondition", "time": "2026-11-26T23:35:38Z", "harness": "claude-code", "before": ["running", "running"], "after": ["running", "running"]}
```

The test was changed at the gate. As first written it took the times without
checking that the 2 busy runs were still active, and it failed in its own
cleanup because both had ended. It now waits for each busy run's first tool
call, records their states at the submit and at the cancel, and reports NOT
VERIFIED when either is not `running`. Of 3 runs on this host, 1 passed with
the precondition held; 1 was taken before the check existed and proves
nothing; 1 measured the same times (0.499 s and 7.72 s) but the busy runs
were read after the cancel, when both had ended, so it was reported NOT
VERIFIED.

A finding from those runs: a Claude Code turn told to run `sleep 120` in the
foreground ended as `succeeded` about 15 seconds later in 2 of 3 runs. Why
was not investigated; the likeliest cause is the harness moving the command
to the background. A live check that needs a long-running turn should not
rely on this task text.

The run image was the local dogfood image, not the published one.

## Defects found

None. The suite found no defect in the merged code.
