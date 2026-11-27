# Delivery Summary — D2 fleet and recovery

plan: `d2-fleet-and-recovery` · run: `partial` · date: `2026-11-26`
baseline: `devague summary skeleton`

## Intent

> culture-agents runs a small fleet without losing track of work: two runs can work in one repository at once, a restarted core takes back live control of the workers that survived it, a duplicate submit is answered once, work is placed only on a host that can take it, a halted host is never reported as a success, and a question a run asks its operator is still waiting after a restart.

After: After part one, on one host: a core that restarts steers, cancels and attaches to the workers that outlived it; one repository holds several active runs up to a stated bound; a repeated submit, steer or cancel with the same idempotency key takes effect once; a run's question to its operator is on disk and answerable after a restart; finished run branches can be listed and removed with evidence. After part two: the same control API is reachable on more than one host, a submit is admitted only where the host can take it, and a run on a halted host reads 'unknown'.

## Planned Work

- `t1` — Probe: can each harness ask its operator a question and wait, without allow-all
- `t2` — Rename the example node from spark to thor in fixtures, tests and documents
- `t3` — Contract 3.0: schemas, fixtures and generated types for every D2 part one change
- `t4` — Run store: schema version, reading 2.0 run directories, startup cleanup
- `t5` — Run store: retention of finished run directories and constant-cost reads
- `t6` — Idempotent submit, steer and cancel with an on-disk key index and crash-safe submit order
- `t7` — Record the base commit when a submit is accepted and build the sandbox from it
- `t8` — Concurrent runs in one repository with operator-configured limits and no implicit limit
- `t9` — Reattach to surviving workers after a core restart, before answering control requests
- `t10` — Close the three recovery gaps recorded after D1
- `t11` — Record the submitter of each run as the core established it; state local authentication
- `t12` — Remove injected secrets from the environment before any worker or host command starts
- `t13` — Operator questions: ask, wait on disk, answer once, 12 hour limit with a paused deadline
- `t14` — Publish run events to the broker from the core, lifecycle facts only
- `t15` — List and remove finished run branches, with evidence
- `t16` — CLI: idempotency keys on every submit, steer and cancel, retry with the same key, and the answer verb
- `t17` — Capability report: configured limits, active runs and admission state per signal
- `t18` — D2 part one acceptance suite and record
- `t19` — Documents for part one: what exists, who it is for, and corrections to stale records
- `t20` — Part two design record: transport, announcement, key handling and repository identity
- `t21` — Network transport beside the Unix socket: key pairs, mutual authentication, off by default
- `t22` — Fleet members: announcement, the member list and unique node names
- `t23` — Remote control calls: submit, steer, cancel and attach on another member
- `t24` — Admission across hosts: harness, limits and signals decide at the executing core
- `t25` — Unreachable members: a view on the caller, never a stored state
- `t26` — Fetch a run's commits from the executing core as a git bundle; restrict cross-host reads
- `t27` — Implement lobes-cli issue 346 in lobes-cli: an admit field with a timestamp on the gateway status
- `t28` — D2 part two acceptance on at least 2 real hosts, and the closing record
- `t29` — Observability: export run traces to a local Langfuse over OTLP, with content off by default
- `t30` — Contract 3.0: let placement be reported as supported, and add a typed refusal for a submit that an admission signal holds
- `t31` — Capability report reads the model gateway's admit field

## Actual Delivery

Every task marked delivered or partial below, except `t20` and `t27`, is on main in pull request 15 (squash `b4d7723`, version 0.16.0).

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `docs/d2/probe-approvals.md` and `spikes/d2-approvals/`; longest measured hold 5 minutes, 12 hours not measured |
| `t2` | delivered | example node renamed to `thor`; `scripts/check-example-node.py` in CI. Done by a host subagent after 3 failed dispatched runs (`d1`) |
| `t3` | delivered | contract 3.0 schemas, fixtures and generated types. Done by a host subagent (`d1`) |
| `t4` | delivered | `core/src/store/{version,entries,startup}.ts`, `docs/d2/upgrade.md`; no test with live 2.0 workers |
| `t5` | delivered | `core/src/store/{retention,summary}.ts`; the summary cache was reworked after review (digest of the log, version check first) |
| `t6` | delivered | `core/src/store/idempotency.ts`, `core/src/runs/keys.ts`; reworked after review (a key stays reserved while a delivery's outcome is unknown) |
| `t7` | delivered | `core/src/runs/base-commit.ts`; not run with a real OpenShell bundle |
| `t8` | delivered | `core/src/runs/limits.ts`, `core/src/daemon/limits.ts`; the `busy` refusal is removed from the contract |
| `t9` | delivered | `core/src/runs/reattach.ts`; reworked after review (a live worker is never read as terminal, reattach is retried) |
| `t10` | partial | 2 of the 3 recovery gaps closed with tests; one line of the third (a conflict reply on an ended run) cannot be reached and is not tested |
| `t11` | delivered | `core/src/daemon/submitter.ts`; the submitter is the socket's owner, since Node cannot read peer credentials |
| `t12` | partial | `core/src/daemon/secrets.ts`: no worker, host command or sandbox inherits the injected secrets, but they stay readable in the core's own `/proc/<pid>/environ` to the same user. The plan text says "removed" |
| `t13` | partial | questions, one answer, the 12 hour limit and the paused deadline, for the stub harness only; the Claude Code and OpenCode drivers have no ask path (`d3`) |
| `t14` | delivered | `core/src/publish/`, `mqtt` 5.16.1; loopback broker only; tested against an in-process broker |
| `t15` | delivered | `agents branches list and remove`,`contract/branches.json`. The first dispatched run (OpenCode) wrote nothing in 82 minutes and was redone on Claude Code |
| `t16` | delivered | keys on every submit, steer and cancel, retry with the same key, `agents runs answer`; text mode shows questions since the review fixes |
| `t17` | delivered | `core/src/runs/admission.ts`: limits, active runs, heat signal (checked against a real signal file on 1 host) |
| `t18` | partial | `tests/acceptance/d2/` mock stage (6 checks) and `docs/d2/part-one-acceptance.md`. Live stage: timing measured for Claude Code only; OpenCode not run; the question check is NOT VERIFIED on both real harnesses |
| `t19` | delivered | `docs/d2/part-one.md`, `docs/d2/corrections.md`, the five prompt files; the published explainer outside the repository is not republished |
| `t20` | partial | `docs/d2/part-two-design.md`, approved by the owner on 2026-11-27, with loopback probes under `spikes/d2-part-two/`. On branch `runs/d2-fleet` (commit `2bba6cf`), not on main |
| `t21` | blocked | dispatched on 2026-11-27 after the design record was approved; running when this was written, nothing merged |
| `t22` | blocked | not started; waits for `t21` |
| `t23` | blocked | not started; waits for `t22` |
| `t24` | blocked | not started; waits for `t23` |
| `t25` | blocked | not started; waits for `t23` |
| `t26` | blocked | not started; waits for `t23` |
| `t27` | delivered | lobes-cli pull request 347, merged by the owner as lobes-cli 0.99.0 (squash `9afb5e0`) |
| `t28` | blocked | not started; needs `t24` to `t26` and at least 2 of the owner's hosts |
| `t29` | partial | `core/src/trace/`: traces over OTLP with Node's fetch, content off by default, loopback endpoint only. No trace was sent to a real Langfuse, and the endpoint path is unconfirmed |
| `t30` | delivered | `placement` supportable and a typed `admission_held` refusal in contract 3.0; schema only |
| `t31` | partial | `core/src/runs/gateway.ts`: the reader works and is tested, but the live read on the build host returned `unknown` because the running gateway served no admission object |

Counts over the 31 plan tasks: 17 delivered, 7 partial, 7 blocked, 0 dropped.

## Mid-work Decisions

- `d1` — An unplanned fix was added ahead of the remaining waves: the literal OpenShell credential placeholder marker was reworded out of five tracked files, and scripts/scan-secrets.py now fails on it. Tasks t2 and t3 moved from agents runs to Claude subagents on the host. — Three agents runs of t2 on the OpenCode harness failed: two because the harness read the marker and the egress proxy refused its next model request, one because of the 1 MiB write chunk. The owner chose 'Fix it first' on 2026-11-26.
- `d2` — Observability was added to the D2 design mid-run: a new decision (c66), four proposed claims (c67 to c70), one assumption (c71) and one proposed plan task for run tracing to a local Langfuse. — The owner asked for it on 2026-11-26 after three OpenCode runs shared one local model with no way to see the load: 'We should have observability and it should be part of the design. We can run langfuse locally.'
- `d3` — Task t13 built operator questions end to end for the stub driver only. The Claude Code and OpenCode drivers got no ask path and still report the answer capability as unsupported, although the t1 probe found both harnesses can ask. — The task instruction says to build exactly what the probe record says each harness supports. The agent had no sandbox or credentials to run either real harness, and the contract allows a capability to be reported supported only once measured as this core drives it, so it left both unsupported and said so in its report. All four acceptance criteria of t13 are met as written; the spec's claim that an operator can answer a real harness's question is not delivered.

- The owner approved two tasks mid-run on 2026-11-27, `t30` (contract shapes for part two) and `t31` (reading the gateway's admit field), so that part two needs no MAJOR contract bump and the capability report does not ship saying "not consulted".
- The owner chose on 2026-11-27 that the trace endpoint must be a loopback address, after the spec's "not to another host" was found unenforced.
- A code review of pull request 15 by four independent reviewers found six must-fix defects that both green suites missed; the owner chose "Fix on this branch". Seven fix runs followed, each reproducing its defect with a failing test first. The review is `docs/d2/reviews/pr-15-review.md`; the fix reports are `docs/d2/task-reports/fix-a.md` to `fix-g.md`.
- Work was dispatched through this repository's own `agents` CLI (D1 core at API 2.0, Claude Code harness in an OpenShell sandbox), one worktree per task. One model per harness per core, so a second core ran the harder tasks on a stronger model. The owner limited local-model (OpenCode) runs to 1 at a time; of the tasks tried on OpenCode only `t27` delivered.
- Retention removes every worker-written terminal state (`timed_out` and `unanswered` too); the documents were changed to match the code, not the code to match the documents (fix-c's choice, not confirmed by the owner).
- The pre-PR second-opinion review in OpenCode ran for over 7 hours on 7 subagents and never reported; the pull request was opened and merged without it, by the owner's choice.

## Drift From Plan

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t2` (`d1`) | Three agents runs of t2 on the OpenCode harness failed: two because the harness read the marker and the egress proxy refused its next model request, one because of the 1 MiB write chunk. The owner chose 'Fix it first' on 2026-11-26. | `acceptable` |
| `t14` (`d2`) | The owner asked for it on 2026-11-26 after three OpenCode runs shared one local model with no way to see the load: 'We should have observability and it should be part of the design. We can run langfuse locally.' | `acceptable` |
| `t13` (`d3`) | The task instruction says to build exactly what the probe record says each harness supports. The agent had no sandbox or credentials to run either real harness, and the contract allows a capability to be reported supported only once measured as this core drives it, so it left both unsupported and said so in its report. All four acceptance criteria of t13 are met as written; the spec's claim that an operator can answer a real harness's question is not delivered. | `needs-follow-up` |
| `t12` | The plan and claim `c44` say the secrets are removed from the environment; they are removed from what children inherit, and stay readable in the core's own `/proc` environment. The documents were corrected; intake by file or descriptor is not built | `needs-follow-up` |
| `t10` | One line of the third D1 gap cannot be reached, so "has a test" holds for the reply but not for that line | `acceptable` |
| `t18` | The live stage was run for Claude Code only; the OpenCode check starts 3 local-model runs at once, against the owner's 1-at-a-time rule | `needs-follow-up` |
| `t29` | No live trace was sent to a real Langfuse; none is installed on the build host | `needs-follow-up` |
| `t31` | The live read returned `unknown`: the running gateway predates the admit field until it is restarted | `needs-follow-up` |
| `t4` | A run directory the core cannot read is skipped by the API listing; claim `c55` says it is never treated as absent. It is kept on disk and counted against limits | `risky` |
| `t20` to `t26`, `t28` | Part two is not delivered in this run; `t20` is written and approved, `t21` is running | `needs-follow-up` |

## Evidence

- tests: `cd core && npm test` at `b4d7723` — 716 tests, 708 passed, 0 failed, 8 skipped (opt-in live, broker-container and sandbox tests)
- tests: `uv run pytest -n auto` at the last gate before the merge — 1770 passed, 13 skipped; `uv run pytest tests/acceptance tests/test_contract_v3.py tests/test_cli_version_3.py tests/test_check_example_node.py` at `b4d7723` — 181 passed, 12 skipped
- tests: `tests/acceptance/d2/test_live.py` on the build host, Claude Code — third submit 0.464 s, cancel 7.67 s, with 2 runs active (recorded in `docs/d2/part-one-acceptance.md`)
- lint: pull request 15's CI at its last commit — 12 checks passed, 2 skipped by design; SonarCloud gate OK, 0 open findings
- scans: `python3 scripts/check-example-node.py` — clean, 664 files; `python3 scripts/scan-secrets.py` — clean, 794 files
- review: `docs/d2/reviews/pr-15-review.md`; the reviewers' reproductions were rerun after the fixes and no longer reproduce the six defects
- evidence ledger: `e1` to `e22` filed on 2026-11-27 against obligations `o1` to `o26`, all `proposed` (filed by the agent, not yet confirmed by the owner); `e21` and `e22` are failing records
- commits: `2cb7f19..b4d7723` on main (1 squash commit); the 162-commit history is on branch `runs/d2-part-one`
- PRs / issues: #15 (part one), #14 (the spec), lobes-cli #347 (`t27`), lobes-cli #346 and #348 (gateway issues), #2 (the authoritative plan)

## Delivery Claims

The table is the tool's rendering. In its confidence column, `pending adjudication` means evidence was filed by the agent and waits for the owner to confirm or reject it, so no row here is asserted as done on the agent's word; `untested` means no evidence is filed, which is every part two claim. Read each as `unverified` until adjudicated. Two rows carry a failing record: `c30` (`e22`: two older records still name the build host's chat server) and `c55` (`e21`: an unreadable run is skipped by the API listing).

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c3` — After a core restart, the core takes back live control (steer, cancel, attach) of every worker that survived it. reconcile() rebuilds the in-memory controls map through the existing reconnectWorker, and the 'reconnect' capability stops being refused. | pending adjudication | `core/test/runs/restart.test.ts::a worker survives a daemon SIGKILL: reported from disk, control reattached, counted against a limit, terminal state reached` (run 2026-11-27) |
| `c4` — Two or more runs can be active in one repository at the same time, each steered independently. No limit applies unless the operator configures one; a configured limit is a check at submit. The one-active-run-per-repository 'busy' rule is removed, and the '`worktree_isolation`' capability reports what is actually guaranteed. | pending adjudication | `core/test/runs/concurrent.test.ts::a per-repository limit refuses the submit past it with limit_reached naming the limit; nothing is queued` (run 2026-11-27) |
| `c5` — Per-run isolation stays what D1 built: each run works in its own sandbox clone made from a git bundle, and its commits return into its own `runs/<id>` branch. The host checkout and index are never written, and no git worktree is created on the host. | pending adjudication | `core/test/runs/isolation.test.ts::2 runs in 1 repository complete; each runs branch holds only its own commits; the host checkout and index are unchanged; no worktree` (run 2026-11-27) |
| `c6` — A duplicate submit with the same idempotency key returns the first run instead of starting a second one, and the same key with a different request is refused as a conflict. Steer and cancel deduplicate on their keys the same way. The key index is on disk, so it holds across a restart. | pending adjudication | `core/test/runs/idempotency.test.ts::a repeated submit key returns the first run and creates nothing; a changed request is conflict; both hold after a restart` (run 2026-11-27) |
| `c7` — A run can ask its operator a question and wait. The question is written to the run's on-disk log, is still pending after a core restart, and 'agents runs answer' delivers the answer into the same run. A harness that cannot ask says so in its capability report. | pending adjudication | `core/test/runs/questions.test.ts::a question survives a core restart and its answer is delivered into the same run exactly once` (run 2026-11-27) |
| `c8` — A submit names where the work may run, and the core admits it only when that host can take it: the harness is available, a configured limit has room, and the host's heat signal does not say hold. The model-gateway signal joins the check for harnesses that use the gateway once lobes publishes an admit field with a timestamp; D2 ships without waiting for it. A signal that is missing or stale reads as unknown: a remote submit is refused and a local one is admitted with a warning. An unknown signal is never a hard failure of the control plane. | untested | (none filed) |
| `c9` — When a host halts or cannot be reached, every run that was active on it reads 'unreachable' to every caller, and never 'succeeded'. 'unreachable' is a view, not a stored state: the stored terminal state 'unknown' is still written only by the owning core, as on one host. | untested | (none filed) |
| `c10` — Finished runs stop accumulating: there is a way to list the `runs/<id>` branches a repository holds, and a rule for removing one that requires positive evidence its commits are kept elsewhere (merged, or on another ref). Unknown liveness defers removal; nothing is force-deleted. | pending adjudication | `core/test/runs/branches.test.ts::removal deletes only a finished, reachable branch with git branch -d, and reports every skip` (run 2026-11-27) |
| `c11` — The three recovery gaps recorded after D1 are closed: a cancel whose grace period ends during retention cleanup still leaves a retention record, the worker's 'conflict' reply on a refused append has a test, and the daemon installs its signal handlers before it reports that it is listening. | pending adjudication | `core/test/daemon/lifecycle.test.ts::SIGTERM sent at the moment of the listening report stops the daemon cleanly (handlers are installed first)` (run 2026-11-27) |
| `c19` — The contract keeps its D1 guarantees: no AI SDK type appears in it, an unsupported action is refused with the typed 'unsupported' error naming the capability, the event cursor stays per run, gapless and never reset, a terminal state is final, and 'unknown' is never reported as success. | pending adjudication | `tests/test_cli_version_3.py::test_a_2_0_client_is_refused_by_a_3_0_core_with_exit_2_naming_both_versions` (run 2026-11-27) |
| `c20` — Workers stay detached processes that never depend on the core: a core stop or crash never signals them, each one enforces its own deadline and writes its own terminal event, and the per-run control socket protocol does not change. | pending adjudication | `core/test/runs/reattach.test.ts::SIGKILL of the core signals no worker; the worker alone enforces its deadline and writes its terminal event` (run 2026-11-27) |
| `c21` — Local use keeps its D1 security posture: the owner-only Unix socket, deny by default dispatch, and an exact-match allow-list that no API route can read or write. A network transport is added beside the socket, not in place of it. | pending adjudication | `core/test/runs/submitter.test.ts::with no network transport the core opens no TCP port, and no route reads or writes the allow-list` (run 2026-11-27) |
| `c29` — A core announces itself as a fleet member when it starts and stops being listed when it stops or goes silent. Callers discover members from those announcements; no list of hosts is kept in the repository or in a tracked file. | untested | (none filed) |
| `c30` — No real host list, address or network detail of the fleet appears in a tracked file, a test fixture or a published record. Fixtures, documents and tests use one example node, a Jetson Thor, in place of 'spark'; acceptance records name real hosts by role (host A, host B). | pending adjudication | `docs/d0/d1-acceptance.md:116 (grep); scripts/check-example-node.py and scripts/scan-secrets.py` (run 2026-11-27) |
| `c34` — Every run event the core appends to a run's log is also published to the existing broker (events-cli), in the envelope that broker's consumers already read. Publishing is best effort and comes after the on-disk append: the log stays the source of truth, a subscriber that missed events catches up from the log by cursor, and a broker that is down or slow never blocks, fails or delays a run. | pending adjudication | `core/test/publish/broker.test.ts::with the broker down nothing is lost: after it returns every missed event is published once, in order, with its original id` (run 2026-11-27) |
| `c35` — Each run records who submitted it, as the core established it and never from a request field: for a local call, the user that owns the control socket; for a call from another host, the authenticated fleet member. The field is in the run's contract shape. Part one does not enforce on it; part two's ownership rules read it. | pending adjudication | `core/test/runs/submitter.test.ts::a run submitted over the socket records the user that owns the socket, and no request field changes it` (run 2026-11-27) |
| `c37` — Cores on different hosts authenticate each other with key pairs, not a shared secret: each core has its own private key, peers hold only its public key, and the connection between two cores is encrypted and mutually authenticated. No secret that grants membership is ever sent over the network, and one host's key gives no access as any other host. | untested | (none filed) |
| `c39` — A remote submit names the repository as the executing host knows it (that host's allow-listed path, or an alias the host defines), and a run's commits can be fetched from the executing core through the control API as a git bundle, so a caller on another host can bring the `runs/<id>` branch home without shell access to that host. | untested | (none filed) |
| `c44` — The core removes its fleet private key and every other injected secret from the environment before it spawns a worker or runs a host command; no worker, sandbox or harness process can read them. | pending adjudication | `core/test/daemon/secrets.test.ts::a marked secret is absent from the worker, a host command and the sandbox after the core starts` (run 2026-11-27) |
| `c45` — Events published to the broker carry lifecycle facts only: run id, event type, state, cursor and time. They never carry prompt text, harness output, tool results or an operator's answer. A subscriber that wants content reads it from the core by cursor, under the core's own access rules. | pending adjudication | `core/test/publish/publisher.test.ts::a message holds run id, event type, state, cursor and time, and no content of the run` (run 2026-11-27) |
| `c47` — A caller that cannot reach a member shows that member's runs as 'unreachable', a view that is never stored. The terminal state 'unknown' is written only by the core that owns the run, when it has evidence that the worker is gone. A run shown as unreachable can still end in any terminal state once its host answers. | untested | (none filed) |
| `c50` — A restarted core finishes reattaching before it answers control requests for a run: until a run's reattach attempt has completed, a steer, cancel or attach for it waits or is answered 'retry shortly', never 'live control unavailable'. Controls of runs that are already terminal are not rebuilt. | pending adjudication | `core/test/runs/reattach.test.ts::a control request before the reattach attempt finished waits, then retry-shortly; never live control unavailable` (run 2026-11-27) |
| `c51` — A submit that was in flight when the core died is accounted for after the restart: its worker, if one was spawned, appears as a run, and a repeat of the same idempotency key returns that run. The order on disk is key first, then the run directory, then the spawn; a key whose run was never established is released, and run directories without a first event and leftover temporary files are removed at startup. | pending adjudication | `core/test/runs/idempotency.test.ts::a submit killed after-spawn: after restart a repeat gives exactly 1 run, no worker runs unlisted, an unestablished key is released` (run 2026-11-27) |
| `c52` — A run's base commit is resolved when the submit is accepted and is written on the run record. Concurrent runs in one repository each start from the commit recorded for them, not from wherever the operator's HEAD is when their sandbox becomes ready. | pending adjudication | `core/test/runs/base-commit.test.ts::a stub run builds from the recorded commit although the host HEAD moved before the sandbox was ready` (run 2026-11-27) |
| `c53` — The operator can configure a limit on concurrent runs per repository and per host; none applies by default. A configured limit is checked when the submit is accepted, and a submit past it is refused with a typed error naming the limit. A host that cannot take a run for lack of capacity refuses at submit where it can know, and otherwise fails the run with a reason that names the capacity. | pending adjudication | `core/test/runs/concurrent.test.ts::a per-host limit refuses the submit past it across repositories; nothing is queued` (run 2026-11-27) |
| `c55` — The run store carries a schema version. A 3.0 core reads run directories written by a 2.0 core and shows those runs; it never treats a record it cannot read as absent, and a run it cannot read never keeps a repository busy for ever. The upgrade procedure is stated: whether active 2.0 workers must finish first, and what the core does if they have not. | pending adjudication | `core/test/store/versioned.test.ts::a run directory written by the 2.0 core is listed with its true state` (run 2026-11-27) |
| `c57` — Broker publishing is done by the core, which follows each run's log and keeps on disk how far it has published per run. After a restart it publishes what it missed, with the same event ids, and workers never connect to the broker. | pending adjudication | `core/test/publish/broker.test.ts::broker down for a whole run, then a core restart: every event is published once, with its original id, after the broker returns` (run 2026-11-27) |

Lapse ledger evidence:

| Lapse | Code | What |
|-------|------|------|
| `l1` | `assumption-for-measurement` | Honesty condition h21 states that scripts/scan-secrets.py 'already fails on non-localhost endpoints in tracked files'. I wrote that from memory of the script's purpose and did not read it. It only checks JSON keys holding http(s) URLs (scripts/scan-secrets.py:14-19), and 'spark' already appears as the example node name in about 170 tracked files. |
| `l2` | `assumption-for-measurement` | I proposed c35 and c36 (the submitter and local authentication come from the Unix socket's peer user) and honesty conditions h24 and h25 without checking that Node can read peer credentials or what the socket's mode is. Node's net API does not expose them and no native addon is present; the socket is mode 0600 in a 0700 directory (core/src/daemon/daemon.ts:36-41, :78, :130-131), so the peer is always the core's own user. The owner confirmed c35 and h24 on that unverified basis. |

## Remaining Work / Follow-up

- `t21` to `t26`, `t28` (part two) — `t21` is running on branch `runs/d2-fleet`; the rest follow in order `t22`, `t23`, then `t24` to `t26`, then `t28` on at least 2 of the owner's hosts. Its own pull request.
- `t20` — approved; lands on main with the part two pull request.
- `t13` (`d3`) — ask paths for the Claude Code and OpenCode drivers, then a live check; no task exists yet. Until then operator questions are usable only with the stub harness.
- `t12` — give the core its secrets by file or descriptor so its own `/proc` environment does not hold them; no task exists yet. The same question is open for the fleet key (design record, question 3, approved at "environment").
- `t29` — send a live trace to a real Langfuse and confirm the endpoint path; needs a Langfuse on the host (owner's decision who installs it).
- `t31` — restart the model gateway on the build host and reread its admit field; an `admit` or `hold` from a real gateway is not verified.
- `t18` — the OpenCode live acceptance check, if the owner allows 3 concurrent local-model runs; the question check on real harnesses waits for `d3`'s follow-up.
- `t4` (`c55`) — decide whether an unreadable run should be shown over the API; the 3.0 contract has no shape for it.
- `c30` — decide whether to redact the two older records that name the build host's chat server (`docs/d0/d1-acceptance.md` line 116 and one delivery record).
- Evidence `e1` to `e22` and deltas `b1` to `b9` — the owner confirms or rejects each.
- Plan risks without a task: `r14` (a failed turn returns no work; it cost one run) and `r15` (a run can end `succeeded` with its task not done).
- A 12 hour question hold was never measured (injected clock only; longest real hold 5 minutes).
- The coverage step of CI failed twice with a cut-off coverage file; a mitigation is in and it has not recurred, but the cause is not proven.
- Housekeeping for the owner: reject the staged dev versions on npm, limit the `npm` and `pypi` environments to `main`, delete stale remote branches (`runs/d2-frame`, `runs/d2-part-one`, `runs/d2-part-two`) and the merged local `runs/spark-…` result branches.
