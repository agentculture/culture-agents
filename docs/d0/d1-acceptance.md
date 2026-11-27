# D1 acceptance record

Plan task t16. This records what the D1 acceptance suite checks, the live run
on the fleet host on 2026-11-25, and which parts of the announcement D1 does
not deliver.

## What the suite is

`tests/acceptance/d1/` drives the real `agents` CLI, as a separate process,
against the real core daemon (`core/dist/src/daemon/main.js`). Each test
starts its own core with its own socket, state directory, allow-list and
temporary git repositories.

| Stage | File | Harness | Runs |
| --- | --- | --- | --- |
| mock | `test_mock.py` | the stub driver (no sandbox, no model) | always |
| live | `test_live.py` | Claude Code and OpenCode v2 in an OpenShell sandbox | only with `CULTURE_AGENTS_ACCEPTANCE_LIVE=1` |

A live check that is not requested, or whose harness the core reports as
unavailable (no gateway, run image or credential provider), is skipped as
`NOT VERIFIED: ...`. A skipped check is never a pass. The mock stage needs
Node and a built core. Without them it is also reported as `NOT VERIFIED`,
unless `CULTURE_AGENTS_ACCEPTANCE_REQUIRE=1` is set, which turns that into a
failure. CI sets it.

```bash
cd core && npm ci && npm run build && cd ..
uv run pytest tests/acceptance/d1                       # mock stage
source <scratch>/osh/env.sh                             # openshell CLI and TLS directory
CULTURE_AGENTS_ACCEPTANCE_LIVE=1 \
CULTURE_AGENTS_ACCEPTANCE_REPORT=<file>.jsonl \
uv run pytest tests/acceptance/d1 -n 2 -rs             # mock and live
```

## Environment of the recorded run

| Component | Version |
| --- | --- |
| Commit | `1be5282` on `runs/d0-d1-spec` |
| `culture-agents` (Python CLI) | 0.12.0, Python 3.13.15 |
| `@culture.dev/agents` (core) | 0.0.0 (unpublished), Node.js 24.13.1 on the host |
| agentfront | 0.21.3 |
| OpenShell CLI and gateway | 0.1.10, gateway on `https://127.0.0.1:17670` |
| Run image | `culture-agents-run:dev`, `sha256:225b9497eb60` (Node.js 22.23.5) |
| `@ai-sdk/harness` / `@ai-sdk/harness-claude-code` | 1.0.192 / 1.0.196 |
| Claude Code (in the adapter's bridge) | 2.1.319, model `haiku`, provider `claude-sub` |
| OpenCode | 2.3.2, model `gateway/worker`, provider `lobes` |
| Host | x86_64, Linux 6.11 |

## Results

Two full runs at `1be5282`, each `16 passed`: 8 mock checks and 8 live checks
(4 per harness). A third full run at `6fe17f9`, after the fixes from the review
of PR #4, also passed 16 of 16: cancel took 7.6 s (Claude Code) and 8.8 s
(OpenCode), and both restarted runs finished `succeeded`. After each run
`openshell sandbox list` showed no sandbox; that was checked by hand, and no
test checks it. The table shows the first two runs.

A fourth full run, after the second round of review fixes (hardened fetch,
process check by pid, bounded waits), passed 16 of 16: cancel took 6.2 s
(Claude Code) and 8.9 s (OpenCode).

A fifth full run on 2026-11-25, after the SonarCloud round: 16 passed in
113 s. It ran on a rebuilt run image (Node.js from a signed apt source, a
declared non-root user) selected with `CULTURE_AGENTS_RUN_IMAGE`, and on the
core after its sequential loops moved to a shared helper and the socket
fallback moved out of `/tmp`. Docker's event log shows the sandboxes were
created from that image. Submit returned in 0.40 to 0.49 s.

| Target | Mock (stub) | Claude Code | OpenCode v2 |
| --- | --- | --- | --- |
| Submit returns a run ID in under 2 s | 0.28 s, 0.27 s | 0.47 s, 0.47 s | 0.50 s, 0.36 s |
| The harness completes a task | pass | pass, 1 commit on `runs/<id>` | pass, 1 commit on `runs/<id>` |
| A mid-run steer changes later output | pass | pass, both runs | pass, both runs |
| Cancel reaches `cancelled` in under 10 s | 0.14 s, 0.14 s | 6.2 s, 6.5 s | 8.9 s, 8.6 s |
| After `kill -9` and restart, every run reports a state | 4 of 4 | 1 of 1, both runs | 1 of 1, both runs |
| Runs reporting a success that is not backed by commits | 0 | 0 | 0 |

Times are wall time of the CLI process: for submit, the whole `agents runs
submit` call; for cancel, from the `agents runs cancel` call until `agents
runs show` reports `cancelled`.

What each row means in detail:

- **Complete.** The result names `runs/<id>` and its commits, the files are on
  that branch in the host repository, and the host checkout is still on `main`
  with a clean status.
- **Steer.** The steer was sent after two tool results. In all four live
  runs the next tool call but one wrote `STEERED.txt` and the harness dropped
  the rest of its plan (three numbered files instead of ten or six).
- **Cancel.** The run's states end `cancelling`, `cancelled`, the result
  reports `cancelled`, and no `runs/<id>` branch exists.
- **Restart, mock.** Four runs with four fates: one finished before the kill
  (`succeeded`), one still working (asserted `running` without live control,
  later `succeeded` with all 120 files on its branch), one hung with its worker alive (`running`,
  without live control, a steer refused as `unsupported`), and one whose
  worker was killed with the daemon (`unknown`). With the core down, the CLI
  exits 2 with `unavailable`.
- **Restart, live.** The run was reported `running` without live control
  after the restart, then finished `succeeded` with every file of its task on
  its branch (ten for Claude Code, six for OpenCode). In the first two runs
  the test only recorded this; since `6fe17f9` it asserts it.
- **Unbacked successes.** Counted in the mock stage since `6fe17f9`: a success
  counts as backed when its last state event is `succeeded`, its result lists
  commits, and its branch holds files in the host repository. In the first two
  runs the figure was a constant in the test, not a measurement.

Also checked in the mock stage: `attach` and `logs` report the same events with
gapless cursors, and `show` reports the same last cursor; dispatch for an agent that is not on the
allow-list is `denied` and creates no run; a second submit for a busy
repository is `busy`.

## Chat independence

The plan asked for the run to happen with the culture server stopped. It was
not stopped: two chat servers (on ports 6667 and 6668)
were running on the host as the owner's live mesh, and stopping them was not
authorized. This is recorded as a proposed deviation on the plan. What was
checked instead:

- **Mock stage.** While a run was steered and cancelled, the core process and
  the worker process held no TCP socket at all, read from `/proc`. The core's
  `HOME` pointed at a temporary directory with no `.culture` configuration in
  it.
- **Live stage.** During a run, no TCP socket of the core or its workers had
  a chat server's listening port as its remote port. The remote ports seen
  were the gateway's (17670) and two to four other ports per run, which were
  not identified individually.

Limits of this check: it is one sample per run, of the core process and the
worker processes only. Child processes (the harness bridge, the `openshell`
CLI, `ssh`), UDP and Unix sockets are not inspected, and a connection opened
and closed between samples is not seen. The live check compares remote ports
only.

Not verified: the same suite on a host where no chat server process exists.
Unprivileged user namespaces are disabled here, so the suite could not be run
in an isolated namespace either.

## Defects the suite found, fixed on this branch

1. **A finished run reported no branch and no commits.** `agents runs result`
   returned `branch: null` and an empty commit list although the commits were
   on `runs/<id>`. The driver now passes the branch and the commit SHAs with
   its outcome, and the worker records them before the terminal event.
2. **An OpenCode cancel took 11.2 s.** The interrupt took effect in 0.5 s. The
   driver then waited a fixed 1.5 s three times before recording `cancelled`.
   It now polls and continues once the harness's processes are gone. The
   remaining time is mostly the gateway deleting the sandbox.

## Keeping a failed run's work

Checked live once, with Claude Code, outside the suite. The collect was made
to fail after the turn completed (the host repository was pointed at the
run's branch name, which the core refuses to fetch into). Observed:

- the run ended `failed`, and its reason named the sandbox, the date it is
  kept until (7 days ahead) and the commands to fetch the work;
- `retained.json` was written in the run directory;
- the sandbox was still on the gateway after the run and after a daemon
  restart, whose start-up reclaim left it alone;
- following the commands in the message fetched `runs/<id>` with `hello.txt`
  into the host repository.

Not checked: that the sandbox is deleted once the 7 days are over (covered by
a unit test with a past date), and the same path with OpenCode.

## Observations

- **Cancel margin is thin for OpenCode.** 8.6 s to 8.9 s against a 10 s
  target, measured with two test processes running in parallel.
- **One OpenCode steer completed the original plan as well.** In an earlier
  run on this day, before the two recorded runs, OpenCode wrote `STEERED.txt`
  and also all six numbered files. The check at that time required the
  original plan to be dropped, and failed. That is the model's choice, so the
  check now requires the steered file to be written after the steer, and
  records whether the plan was dropped (`plan_abandoned`) without asserting
  it. In that run it is not known whether the steer reached the model before
  or after the last numbered file.
- **Live turns spent:** 44 (three recorded runs of 8, one earlier run of 8,
  2 wiring checks, 6 debugging runs, 4 after the colleague review).

## Not delivered by D1

The announcement describes the end state of issue #2. D1 delivers the
single-host control plane only. Not delivered, and tracked by the issues
linked from issue #2:

- **D2, fleet and recovery:** more than one host, placement, reconnecting live
  control to a worker after a daemon restart (a surviving run is reported from
  disk and cannot be steered or cancelled until it ends), idempotent
  resubmission.
- **D3, chat split:** `culture-chat` as a separate product. `culture` still
  embeds the IRC server and the agent daemons.
- **D4 and D5:** `culture-rules` and `embodiment` as consumers of the control
  API.
- **D6, migration:** nothing is archived or deprecated. `cultureagent` and
  `agent-lifecycle` are unchanged, so harness and dispatch code is still
  duplicated across repos.
- **Verbs:** `pause`, `resume`, `answer` and `artifacts` are refused as
  `unsupported`. Sessions cannot be continued and runs cannot delegate.
- **Harnesses:** Codex is not verified. Only Claude Code and OpenCode v2 run.
- **Packaging:** `@culture.dev/agents` is not published to npm.
