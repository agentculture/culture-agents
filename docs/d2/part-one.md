# D2 part one: what exists, who it is for

Part one of D2 (fleet and recovery) is the single-host half. Part two (several hosts, a
fleet view, placement, fetching a run's commits from another host) is **(planned)**: no
code for it is on disk. The spec is `docs/specs/2026-11-25-d2-fleet-and-recovery.md` and
the plan is `docs/plans/2026-11-26-d2-fleet-and-recovery.md`. The measured results are
in `docs/d2/part-one-acceptance.md`; the per-task reports are in
`docs/d2/task-reports/`.

## Who it is for

A **calling agent** is a program that submits work without a person watching: the
`agents` CLI, and later chat (D3), culture-rules (D4) and embodiment (D5), all
(planned). It needs the core to give a true answer after a timeout, a restart or a
retry. The **operator** is the person who owns the host and sets its limits.

## The D1 state this replaced

| D1 behaviour (control API 2.0) | Part one behaviour | Where |
| --- | --- | --- |
| A restarted core read a surviving worker's state but could not steer, cancel or attach; `reconnectWorker` was only called by tests | The core rebuilds live control of every surviving worker at start; a live worker that does not answer keeps its logged state with `live_control: false` and is retried | `core/src/runs/reattach.ts`, `core/src/runs/service.ts` (`reconcile`) |
| A second submit to a repository with an active run was refused as `busy` | No implicit limit. An operator may configure limits; a submit past one is refused as `limit_reached` | `core/src/runs/limits.ts` |
| The idempotency key was stored on the run and never compared | A repeated key takes effect once; a changed request with the same key is `conflict`; keys survive a restart | `core/src/store/idempotency.ts` |
| `answer` was always refused as unsupported | A run can ask its operator a question; it waits on disk and is answered once, after a restart too (stub harness only, see gaps) | `core/src/worker/questions.ts` |
| A run started from whatever the repository held at start | The base commit is resolved and recorded at accept time | `core/src/runs/base-commit.ts` |
| No store version, no retention, one unreadable run could break a listing | `store.json` schema version, retention of finished runs (30 days by default), startup cleanup, unreadable runs skipped by listing | `core/src/store/` |
| No branch tooling | Finished `runs/<id>` branches can be listed and removed, with evidence | `core/src/runs/branches.ts` |

Also built: submitter and local authentication on the socket (`core/src/daemon/submitter.ts`),
injected secrets leave the environment at start (`core/src/daemon/secrets.ts`), the capability
report with limits, active runs and admission (`core/src/runs/admission.ts`), and tracing
(`docs/d2/observability.md`). Corrections to stale records are in `docs/d2/corrections.md`. Upgrading a 2.0 store is in `docs/d2/upgrade.md`.

## Why recovery is the condition for archiving agent-lifecycle and cultureagent

Issue #2 allows archiving `agent-lifecycle` (supervision) and `cultureagent` (harness
wrappers) only after this repository passes recovery tests. They are the code a caller
would otherwise lean on to keep work alive. If they were archived while this core still
lost control of its workers at a restart, or ran a retried submit twice, the fleet would
have no supervised path left. Nothing is archived: part one supplies the recovery
evidence (`docs/d2/part-one-acceptance.md`, mock stage) and the owner decides about
archiving later, D6 at the earliest. Recovery here means: restart without losing live
control, no duplicate run from a retry, a pending question kept, and no success the core
did not observe. Supervision state that `agent-lifecycle` holds only in memory (its
restart budget) is not ported (planned).

## What a calling agent may rely on

After a **restart** of the core:

- Runs whose worker survived are live again: steer, cancel and attach work. Until the
  reattach attempt for a run ends, a control request waits, then answers `unavailable`
  with `retry_after_ms` (retry it). A live worker that does not answer keeps its logged
  state with `live_control: false`; it is never reattached by guess and never signalled,
  and the core retries the reattach (next control request, bounded backoff) while it lives.
- A run whose worker is gone is never reported `succeeded` without the worker's own
  `succeeded` event. `succeeded` means the turn ended cleanly, **not** that the task was
  done.
- A pending operator question is still pending, with the same id.

After a **retry** with the same idempotency key:

- Submit, steer and cancel take effect once. The same key and request returns the
  first answer; a different request with that key is `conflict`. A key is scoped to its
  route and, for steer and cancel, to the run. A key is kept while its run is in the
  store and 7 days after it ended. A steer or cancel whose outcome is not known yet (no
  answer in time) keeps its key reserved: a retry gets `unavailable` and is not delivered
  again until the run's log settles it.
- The CLI sends a key on every submit, steer and cancel (generated when none is given)
  and retries with the same key after a timeout. `runs answer` is sent once and never
  retried; a second answer is `conflict`.

It may **not** rely on: pause, resume, artifacts or delegation (below), a run on another
host (planned), or a hold longer than measured.

## Steer is not preemption

`steer` is delivered into the harness's running turn, not instead of it. It can land
after work the caller meant to redirect. Interrupting a turn belongs to pause and
resume, which are not built. `cancel` is the way to stop a run.

## Still unsupported

`pause` and `resume` answer `unsupported` (capability `pause`, `resume`), delegation
(`parent_run_id` on a submit) answers `unsupported` (capability `delegate`), and there
is no `artifacts` route or verb at all (planned). A test asserts all four:
`tests/acceptance/d2/test_unsupported.py`.

## Gaps, stated plainly

- Operator questions work end to end only with the stub harness. The Claude Code and
  OpenCode drivers have no ask path and report `answer` as unsupported; the owner has
  not yet decided on a follow-up.
- No hold of 12 hours was measured; the longest measured hold was 5 minutes
  (`docs/d2/probe-approvals.md`).
- The capability report reads the heat signal (checked against a real signal file on 1
  host) and, for OpenCode, the model gateway's `admission` object (lobes-cli 0.99.0; 1 s
  timeout; anything unreadable, stale or future-stamped reads unknown). The gateway read is
  proven with injected and loopback test servers only; the live read is NOT VERIFIED until
  filled in (`docs/d2/part-one-acceptance.md`). A hold does not refuse a submit in part one.
- A run directory the core cannot read is skipped by listing and not shown over the API.
- Enabling broker publishing on a store with history replays that history; the broker
  URL is loopback only.
- Tracing to Langfuse: the endpoint path was not confirmed against a live Langfuse.
- The live acceptance rows are NOT VERIFIED until filled in on a host with the gateway.
