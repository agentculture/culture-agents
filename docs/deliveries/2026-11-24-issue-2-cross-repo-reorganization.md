# Delivery Summary — issue-2 cross-repo reorganization

plan: `issue-2-cross-repo-reorganization` · run: `partial` · date: `2026-11-24`
baseline: `devague summary skeleton`

The run is `partial` for two reasons: task `t5`'s pull request in the culture
repository is still open, and the `Tests` workflow on `main` failed at the
SonarCloud quality gate right after the merge (see Evidence and Remaining
Work). Everything else in the plan merged in
[PR #4](https://github.com/agentculture/culture-agents/pull/4) as commit
`92937aa`.

## Intent

> AgentCulture has one direct agent control plane (culture-agents), one communication product (culture-chat), one workflow engine (culture-rules), and independently deployable experience apps (embodiment/Gwen): no duplicated harness or dispatch managers, no requirement that agents join chat, and no lost realtime or safety guarantees.

After: On a single host, 'agents runs submit' hands a task to a TS core daemon and returns a durable run ID; the run can be listed, shown, attached to as a live event stream, steered mid-run and cancelled, against real harnesses, with no chat server running; run state is stored on disk and read back truthfully after the daemon restarts.

This run covered gates D0 (inventory and contract) and D1 (single-host control
plane) of issue #2. D2 to D6 were out of scope.

## Planned Work

Quoted verbatim from the `devague summary` skeleton:

- `t1` — Probe: Claude Code and Codex through the AI SDK adapters inside an OpenShell sandbox on this host
- `t2` — D0 inventory of agentirc, cultureagent and agent-lifecycle against upstream main, plus a baseline of sibling checkouts
- `t3` — D0 compatibility matrix and decision records
- `t4` — File one tracking issue per later-gate sibling repo and link them from issue #2
- `t5` — Workspace map in the culture repo
- `t6` — Control-plane contract: versioned JSON Schemas and a contract test kit
- `t7` — TS core package scaffold with exact pins and CI coverage
- `t8` — Core daemon: control socket, single-instance lock, API version and deny-by-default authorization
- `t9` — Run store and per-run worker process
- `t10` — OpenShell sandbox provider and run policy
- `t11` — Harness adapters for Claude Code and Codex with honest capability reporting
- `t12` — Run orchestration: submit, attach, steer, cancel, busy refusal and restart reporting
- `t13` — agents CLI noun groups on agentfront
- `t14` — Prompt files, harness-smoke config and CLAUDE.md rules updated together
- `t15` — Release workflow: npm with provenance first, then PyPI
- `t16` — D1 acceptance suite and recorded live run on this host
- `t17` — Boundary audit before the final PR

## Actual Delivery

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `docs/d0/probe.md` and `spikes/d1-probe/`. Claude Code passed; Codex failed inside the sandbox, so OpenCode v2 was probed and chosen (`d1`). |
| `t2` | delivered | `docs/d0/inventory.md`, `docs/d0/sibling-baseline.txt`, checked by `scripts/check-d0-citations.py`. |
| `t3` | delivered | `docs/d0/compatibility-matrix.md`, `docs/d0/decisions.md`. |
| `t4` | delivered | 12 tracking issues on the sibling repositories, linked from issue #2. |
| `t5` | partial | `docs/workspace-map.md` is written and pushed as agentculture/culture#532, which is still open. |
| `t6` | delivered | `contract/*.json` with fixtures, the Python contract tests, and the TypeScript contract module `core/src/contract/` (`d3`). |
| `t7` | delivered | `core/` package with exact pins, a lockfile, and the `core` CI job. |
| `t8` | delivered | `core/src/daemon/`: Unix-socket API, instance lock, version check, allow-list that ships empty. |
| `t9` | delivered | `core/src/store/` and `core/src/worker/`: on-disk event log and one detached worker per run. |
| `t10` | delivered | `core/src/sandbox/`, `core/policy/`, `core/image/`: OpenShell provider, default-deny policy, run image. |
| `t11` | delivered | `core/src/harness/`: Claude Code and OpenCode v2 drivers, a stub driver, capability documents. Codex is not built (`d1`). |
| `t12` | delivered | `core/src/runs/`: submit, attach, steer, cancel, busy refusal, restart reporting. Started alongside `t11` (`d4`). |
| `t13` | delivered | `agents agents list\|status` and `agents runs submit\|list\|show\|attach\|steer\|cancel\|logs\|result` on agentfront 0.22 (agentculture/agentfront#60, merged). |
| `t14` | delivered | The five prompt files, `scripts/_harness_smoke/`, and `CLAUDE.md` updated together. |
| `t15` | delivered | `.github/workflows/publish.yml`: npm with provenance, then PyPI. On the merge, PyPI 0.13.0 was published; the npm step was skipped because `core/package.json` is `0.0.0`. |
| `t16` | delivered | `tests/acceptance/d1/` and `docs/d0/d1-acceptance.md`. Six live runs in total, the last at the merged commit, 16 of 16 each time; chat servers stayed up (`d5`). |
| `t17` | delivered | `docs/d0/boundary-audit.md`. |

Work that no plan task named also landed in PR #4:

- Two rounds of review fixes after independent reviews of the pull request:
  bounded waits in the OpenCode driver, 7-day retention of a
  sandbox whose commits could not be collected, response validation in the
  CLI, escaping of control characters in run text, a stream line cap.
- SonarCloud wiring (scan, quality gate, open-issues gate, coverage for both
  languages) and the fixes for its 240 findings on the pull request,
  including the loop refactor into `core/src/util/sequence.ts`.
- The control socket's fallback path moved from `/tmp` to the user's state
  directory.

## Mid-work Decisions

- `d1` — The second required D1 harness changes from Codex to OpenCode v2; Codex is reported not verified. — The probe showed Codex authenticating in an OpenShell sandbox but failing with 'selected workspace missing from routing discovery' and denied \*.oaiusercontent.com hosts; the user chose on 2026-11-25 to mark Codex not verified and use OpenCode v2.
- `d2` — Task t5's commit in the culture worktree was made with git hooks skipped. — The repo's installed pre-commit environment cannot build its markdownlint hook (nodeenv fails on a '0-alpha' version string). The same hooks were run from an isolated environment with a current nodeenv and all passed on the staged files; the user approved the commit on 2026-11-25.
- `d3` — An extra build step was inserted before t8 and t9: a shared TypeScript contract module (schema loader, validator, derived types, state-machine and version helpers) under core/src/contract/. — t6's instruction left the TS side of the contract to 'its own task', but no task owned it; t8 and t9 run in parallel and would each have added a validator and edited core/package.json.
- `d4` — t12 (orchestration) was started in parallel with t11 (harness adapters) instead of after it. — t12 codes against a fixed harness-catalog port and the worker's fake driver, so it does not need the real adapters; the coordinator connects the real catalog after both merge. This shortens the run without changing what either task delivers.
- `d5` — t16 live acceptance ran with the two culture chat servers (spark :6667, sbx :6668) still running on the host instead of stopped; chat independence was shown by inspecting the TCP sockets of the core and worker processes (none in the mock stage; none to a chat server port in the live stage) — The chat servers are the owner's live mesh; stopping them is disruptive and was not authorized. Unprivileged user namespaces are disabled on this host, so the suite could not be run in an isolated process and network namespace either.

Decisions that no deviation record covers. Each is filed as a proposed
behavioural delta where it changes behaviour:

- A run whose turn completed but whose commits could not be collected keeps
  its sandbox for 7 days, so the work is not lost (delta `b2`). The plan said
  the sandbox is deleted at every terminal state.
- The control socket's fallback moved out of `/tmp` to
  `${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock`, and
  `contract/api.json` changed with it while the API version stayed 1.0
  (delta `b3`). The owner has not yet decided whether to bump the version.
- The CLI validates every core response against the contract schemas, which
  added `jsonschema` as a second runtime dependency, approved by the owner
  (delta `b4`).
- The npm package stays at `0.0.0` and is not published until the owner
  bootstraps the package name; the workflow skips the npm step until then.
- One SonarCloud issue (S5332, the `http://` default for the local gateway)
  was marked Accepted on the owner's instruction. All others were fixed in
  code.

## Drift From Plan

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t1` (`d1`) | The probe showed Codex authenticating in an OpenShell sandbox but failing with 'selected workspace missing from routing discovery' and denied \*.oaiusercontent.com hosts; the user chose on 2026-11-25 to mark Codex not verified and use OpenCode v2. | `acceptable` |
| `t5` (`d2`) | The repo's installed pre-commit environment cannot build its markdownlint hook (nodeenv fails on a '0-alpha' version string). The same hooks were run from an isolated environment with a current nodeenv and all passed on the staged files; the user approved the commit on 2026-11-25. | `acceptable` |
| `t6` (`d3`) | t6's instruction left the TS side of the contract to 'its own task', but no task owned it; t8 and t9 run in parallel and would each have added a validator and edited core/package.json. | `acceptable` |
| `t12` (`d4`) | t12 codes against a fixed harness-catalog port and the worker's fake driver, so it does not need the real adapters; the coordinator connects the real catalog after both merge. This shortens the run without changing what either task delivers. | `acceptable` |
| `t16` (`d5`) | The chat servers are the owner's live mesh; stopping them is disruptive and was not authorized. Unprivileged user namespaces are disabled on this host, so the suite could not be run in an isolated process and network namespace either. | `acceptable` |
| `t5` | The workspace map is not on culture's `main`: agentculture/culture#532 is open. No record covers this. | `needs-follow-up` |
| `t10` | A sandbox is kept for 7 days when a run's commits could not be collected, where the plan had it deleted at every terminal state (delta `b2`). No deviation record covers this. | `acceptable` |
| `t6` | `contract/api.json` changed (`socket_fallback`) without an API version bump, where the obligation on `c42` says a schema change bumps the version (delta `b3`). No deviation record covers this. | `needs-follow-up` |
| `t15` | The npm-before-PyPI order has never run: the npm step is skipped at `0.0.0`, so the merge published to PyPI alone. No record covers this. | `needs-follow-up` |
| `t7` | The `Tests` workflow on `main` failed after the merge at the SonarCloud quality gate, though every check on the pull request passed. No record covers this. | `risky` |

## Evidence

All runs below were made on 2026-11-25 at the merged commit `92937aa`.

- tests: `cd core && npm test` — 451 passed, 0 failed, 8 skipped (live-only)
- tests: `uv run pytest -n auto` — 1228 passed, 9 skipped
- tests: `uv run pytest tests/acceptance/d1` (mock stage) — 8 passed, 8 skipped (live stage not requested)
- tests: `tests/acceptance/d1` with `CULTURE_AGENTS_ACCEPTANCE_LIVE=1` and
  `CULTURE_AGENTS_ACCEPTANCE_REQUIRE=1`, image `culture-agents-run:sonar` —
  16 passed in 114 s, both harnesses; no sandbox left on the gateway
- tests: `core/test/sandbox/live.test.ts` against the real gateway — 2 passed;
  an https push and an ssh push from inside the sandbox were both denied
- CI on the pull request at `b9a0d80`: every check passed; SonarCloud showed
  0 open issues on the pull request
- CI on `main` at `92937aa`: `Publish to npm and PyPI` succeeded (PyPI
  0.13.0 exists; npm skipped). `Tests` **failed**: its `test` job stopped at
  `QUALITY GATE STATUS: FAILED`. SonarCloud lists 34 open issues on the
  `main` branch that the pull-request analysis did not show: 31 on the
  workflow files (`githubactions:S8541` and `S8544` on the `uv` install and
  run steps, one `S6505`), two `python:S3776`, and one `typescript:S2187` on
  `core/test/harness/live.test.ts`
- review: the cortex review of the loop refactor found no defects; its four
  nits were fixed in `b9a0d80`
- commits: `421f9b2..92937aa`
- PRs / issues: #4 (merged), agentculture/culture#532 (open),
  agentculture/agentfront#60 (merged), #5 (D2 follow-ups),
  agentculture/guildmaster#157
- delivery ledger: evidence `e1` to `e17` and deltas `b1` to `b4`, all filed
  as proposed and awaiting the owner's adjudication

## Delivery Claims

The evidence ids refer to records in the delivery ledger
(`devague evidence --list`). They are proposed records: the confidence below
is this summary's reading of them, and it stands only if the owner confirms
them.

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c40` — a run can be submitted, listed, shown, attached to, steered and cancelled on one host against real harnesses with no chat involvement, and its state is read back truthfully after a restart | high | `e7`, `e8` · live stage 16 of 16 at `92937aa` · `docs/d0/d1-acceptance.md` |
| `c36` — the CLI refuses an incompatible core with exit 2, naming both versions, and sends it nothing else | high | `e1` · `tests/test_cli_runs.py::test_incompatible_core_is_refused_naming_both_versions` |
| `c44` — the CLI noun groups exist with `--json`, explain entries and the exit-code contract; with no core every verb exits 2 | high | `e2` · `tests/test_cli_surface.py` |
| `c45` — dispatch is denied by default and enforced by the core | high | `e3` · `tests/acceptance/d1/test_mock.py::test_dispatch_is_denied_by_default_and_a_busy_repository_is_refused` |
| `c42` — both sides validate against the same schemas in `contract/` | medium | `e4`. Capped: nothing tests that a schema change bumps the API version, and one change did not (`b3`); lapse `l7` |
| `c12` — no AI SDK, OpenShell or vendor name is in the public contract | medium | `e5`. Capped: real CLI output and live events are not scanned for names |
| `c9` — a run is durable on disk before submit returns, and its worker outlives the core | medium | `e6`. Capped by lapses `l8` and `l9` (tests written after the code; two worker test deadlines loosened without a cause found) |
| `c54` — after a restart a surviving worker is reported from its log and is not stopped or controlled | high | `e7` · live kill -9 test passed for both harnesses |
| `c51` — the core is single-instance, with safe stale-socket cleanup | high | `e9` · `core/test/daemon/lifecycle.test.ts` |
| `c43` — a control action outside a harness's declared capabilities is refused as unsupported and never forwarded | high | `e10` · `core/test/harness/registry.test.ts` |
| `c57` — every harness process runs inside a per-run OpenShell sandbox that is removed afterwards | medium | `e11`. Capped: one case now keeps the sandbox for 7 days by design (`b2`); lapse `l6` (whether Claude Code is affected by the dropped telemetry hosts was not measured) |
| `c50` — the sandbox holds none of the operator's GitHub credentials and cannot push to the remote; one active run per repository | high | `e12` · live sandbox test at `92937aa` |
| `c26` — nothing changed in cultureagent or agent-lifecycle | medium | `e13`. An observation of the GitHub API, not a compatibility test |
| `c4` — sibling changes were made only in dedicated worktrees and by pull request | low | `e14`. Worktrees and pull requests were observed; that no command ever wrote in a primary checkout rests on the session record |
| `c49` — every npm dependency is an exact pin with a committed lockfile, installed with `npm ci` | high | `e15` · `tests/test_ts_scaffold.py::test_core_package_json_has_no_range_specifiers` |
| `c53` — only working verbs are registered, and unbuilt capabilities are reported as unsupported | high | `e16` · PyPI 0.13.0 published from `92937aa` |
| `c55` — npm publishes with provenance before PyPI, and a failed npm publish leaves nothing on PyPI | unverified | `e17` covers the workflow's structure only. No npm publish has ever run, so this is not claimed done |
| D0 inventory, matrix and decisions describe the sibling repositories accurately | medium | `docs/d0/`. Capped by lapses `l1`, `l2`, `l3` (citations checked for existence, not meaning; status taken from issue #2; one count corrected) |
| The probe's single-trial results for steer and cancel hold | medium | Lapse `l4` applied to the probe; six later live runs passed the same actions for both harnesses |
| The loop refactor changed no behaviour | medium | Independent cortex review found no defects; `readInstanceInfo` now has direct tests (`b9a0d80`). Lapse `l15` records that this was first checked by reading only |
| `main` is green after the merge | unverified | The `Tests` workflow on `main` failed at the SonarCloud gate. Not claimed |
| The Codex harness works | unverified | Not built (`d1`). Not claimed |

Lapse ledger evidence:

| Lapse | Code | What |
|-------|------|------|
| `l1` | `grader-unverified` | t2's citation checker verifies only that each cited file exists at the pinned SHA and has that many lines; whether the inventory's prose matches the cited line rests on one read by the task agent, with no second reviewer. |
| `l2` | `assumption-for-measurement` | t5's workspace map takes its Status table and the consolidation gates for codexd, agent-lifecycle and cultureagent from issue #2 and the spec, read by the task agent, not from the live state of those repos. |
| `l3` | `provenance-missing` | The spec's scope entry s18 states culture has 86 cultureagent import sites; t2's inventory at upstream main counts 47 import lines in `culture_core`. The earlier figure came from a subagent grep of a stale checkout and was recorded without a second count. |
| `l4` | `n-below-claim` | The t1 spike ran each live capability once (Claude cancel twice); steer, stream and cancel results for Claude Code and OpenCode 1.19.5 rest on single trials, and the OpenCode 1.19.5 steer pass was judged on the resulting file list alone, so it may partly reflect the model choosing to stop. |
| `l5` | `assumption-for-measurement` | The t1 spike's statement that the Claude Code adapter reads host credentials unless 'auth: {}' is passed comes from reading the adapter source, not from a test; and it did not check whether Claude's calls to statsig.anthropic.com and sentry.io were denied by policy. |
| `l6` | `assumption-for-measurement` | t10's provider profiles and run policy were linted but not imported on the gateway, so whether their binary globs match at runtime, and whether Claude Code works without the statsig and sentry hosts it dropped, is unmeasured; the sandbox-leak cleanup was tested with a stand-in, not a real adapter failure. |
| `l7` | `grader-unverified` | t6's contract tests validate with Python jsonschema only; the schemas were not run through the TypeScript validator (Ajv) the core will use, and the fixture generator script was left uncommitted in the scratch area. |
| `l8` | `control-absent` | t9 wrote its tests after the implementation skeleton rather than test-first, as its task agent reported. |
| `l9` | `instrument-changed-mid-series` | The integration-fix task loosened two worker tests' deadlines from 200/300 ms to 1.5 s and added cleanup retries after they failed 4 of 10 full-suite runs; the cause (possibly load from the added tests) was not established, and the base commit had passed only 6 of 6. |
| `l10` | `control-absent` | The store/daemon fix agent wrote the fixes for the liveness and event-log items before their tests; the liveness tests' failure on the original code is by reasoning only (they import the new error class) |
| `l11` | `control-absent` | The CLI fix agent wrote `_text.py` and `_contract.py` before their tests, and one broken-pipe case (runs logs --json) passes without the fix |
| `l12` | `control-absent` | The sandbox/harness fix agent did not observe most of its new tests failing before the fix (the new exports would not compile) |
| `l13` | `assumption-for-measurement` | Reported culture-agents-run:dev as unchanged after a declined command; the retag in that command had taken effect and :dev pointed at an untested rebuild. |
| `l14` | `assumption-for-measurement` | Told the owner only they could mark a SonarCloud issue Accepted; the vendored sonarclaude skill can, with the token held by grant. |
| `l15` | `control-absent` | The loop refactor (core/src/util/sequence.ts, 16 sites) was checked against the other Sonar rules by reading, got no independent review, and readInstanceInfo has no direct test; equivalence at that site rests on reading. |

## Remaining Work / Follow-up

- `Tests` on `main` is red at the SonarCloud quality gate — fix or accept the
  34 findings the branch analysis shows (mostly the `uv` steps in the two
  workflow files) in a follow-up pull request. Owner decides which, if any,
  to accept.
- `t5` — agentculture/culture#532 is open; the workspace map is delivered
  when the culture maintainers merge it.
- Evidence `e1` to `e17` and deltas `b1` to `b4` are proposed — the owner
  confirms or rejects them (`devague evidence --confirm`, `devague delta
  --confirm`).
- API version — decide whether the `socket_fallback` change calls for a bump
  from 1.0 (`b3`).
- npm — the owner bootstraps `@culture.dev/agents`, then Trusted Publishing
  takes over; until then `c55` stays unverified.
- Codex — not verified (`d1`); tracked for a later gate.
- `culture-agents-run:dev` still points at an untested rebuild; the tested
  image is tagged `:sonar`. Owner decides whether to move the tag.
- A cancel whose grace period expires during retention cleanup leaves the
  sandbox without a retention record. The worker's `conflict` reply on a
  refused append has no test.
- D2 follow-ups from the reviews are in #5; D2 to D6 are not built.
