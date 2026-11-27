# Handoff: issue #2 reorganization, after D0 and D1

Written 2026-11-25, after D0 and D1 merged and the core's first npm release.
This is working state, not a design document. The authoritative records are:

- the frame and plan under `.devague/` (slug
  `issue-2-cross-repo-reorganization`), with the spec in `docs/specs/` and
  the plan in `docs/plans/`;
- `docs/d0/` (inventory, matrix, decisions, probe, acceptance record,
  boundary audit);
- the delivery summary
  `docs/deliveries/2026-11-24-issue-2-cross-repo-reorganization.md` and the
  derived `docs/current-spec.md`.

## D2 workforce run in progress (written 2026-11-26, 19:45 UTC)

Read this section first. It supersedes "Start here", "Open items" and
"Inputs for D2" below, which describe the state before D2 was planned.

### Where the work is

- Branch `runs/d2-part-one`, based on `main` after PR 14 (0.15.3). It holds
  the confirmed plan, the split record and every merged task. The version is
  not bumped yet; bump and write the changelog when the pull request opens.
- Spec `docs/specs/2026-11-25-d2-fleet-and-recovery.md` (re-exported with
  observability, claims c66 to c71). Plan
  `docs/plans/2026-11-26-d2-fleet-and-recovery.md`, 29 confirmed tasks.
  Assignments and models:
  `docs/plans/2026-11-26-d2-fleet-and-recovery-split.md`.
- The owner's status artifact is
  `https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7` (version 9; source in
  the scratchpad as `issue-2-map.html`, update by publishing that path).
- A session cron job posts a status every 20 minutes; it dies with the session.

### Task state

| Task | State |
| --- | --- |
| t1 to t19, t29, t30, t31 (all of part one) | merged |
| t27 lobes-cli admit field | merged by the owner as lobes-cli pull request 347 |
| part two (t20 to t26, t28) | not started; t20 needs the owner's approval before t21 to t26 |

Pull request 15 (`runs/d2-part-one` into `main`) is open since 03:44 UTC on
2026-11-27. At commit `2f728d6` (05:05 UTC) every CI check passes and the
SonarCloud gate is OK with 0 open findings; the two clean-up runs are merged.

**It must not merge yet.** A code review at `c47d690` (four independent
reviewers; the review is `docs/d2/reviews/pr-15-review.md`, their probes are
in the scratchpad under `rv/a1` to `rv/a4`) gave request-changes with six
reproduced must-fix defects and eleven should-fix ones. None is fixed. The
owner was asked whether to fix them on this branch and has not answered.
The must-fix six: a steer slower than its timeout is delivered twice
(`runs/service.ts` `keyed`, `store/idempotency.ts` `settleKey`); start-up key
pruning drops the key of an unreadable run (`service.ts` `pruneKeys`); one
missed ping at reattach reads a live run as terminal `unknown` for good
(`runs/reattach.ts`, `runs/scan.ts`); the summary cache is read before the
store-version check (`store/run-store.ts`); start-up cleanup ignores the
store version (`store/startup.ts`); a summary is trusted on its byte count
alone (`store/summary.ts`).

The owner approved t30 and t31 on 2026-11-27 and confirmed deviations d1, d2
and d3.

Version bumped to 0.16.0 with its changelog entry (commit `76ba4cf`). The
pre-PR review runs in OpenCode with `gateway/cortex` (started 23:57 UTC,
session title "D2 part one pre-PR review", output in the scratchpad
`logs/prepr-review.log`). Next: read its findings, fix what is real, open the
pull request with the `cicd` skill, then `/validate-delivery` and
`/summarize-delivery`.

The live stage of the part one acceptance suite was run on the host for
Claude Code only (timing check measured; see
`docs/d2/part-one-acceptance.md`). OpenCode is NOT VERIFIED: its check starts
3 local-model runs at once, against the owner's 1-at-a-time rule. To run the
live stage: source the scratchpad `core-env.sh` in a subshell, put the
OpenShell binary's directory on `PATH`, set
`CULTURE_AGENTS_ACCEPTANCE_LIVE=1`.

Deviation `d3` (approved by the owner 2026-11-27): t13 built operator
questions for the stub driver only; the Claude Code and OpenCode drivers have
no ask path and report `answer` as unsupported. The real ask paths are
follow-up work, not in the part one pull request.

Open finding, waiting on the owner: the trace endpoint
(`core/src/trace/config.ts`) accepts any http or https URL, while the spec
says traces do not go to another host. Recommended: refuse a non-loopback
endpoint, as the broker config does.

The OpenCode run of t15 (`01M8CMGNK4T2NR1DTBFN42CDAD`) ended as succeeded
after 82 minutes with no file written: the model printed a malformed tool
call as text and the turn ended. Its only commit is a stray
`core/node_modules` symlink; do not merge that branch. Recorded as plan risk
r15.

Last merge gate (after t19, 23:53 UTC), on the merged tree: core 652 passed
and 8 skipped, Python 1694 passed and 13 skipped, lint, contract types and the
three scans clean. The scratchpad scripts `mg.sh <run ULID>`, `gate.sh <task>`,
`ci.sh <message file>` and `dispatch.sh <task> <ag|ag-opus> [note file]` do the
merge, the gate, the commit and the dispatch.

Not done for t29: the live check against a real Langfuse on the host.

### How dispatch works (dogfooding the `agents` CLI)

- Two dispatch cores run from the worktree
  `../.worktrees.culture-agents/dispatch-core` (0.15.2 plus the chunk fix,
  API 2.0): the default socket runs Claude Code on sonnet, and
  `/run/user/1000/culture-agents/core-opus.sock` runs it on opus. Each has
  its own state directory, `culture-agents-dogfood` and
  `-dogfood-opus` under the state home. Both were started as background tasks of this session;
  they do not survive it. Their environment is in the scratchpad file
  `core-env.sh` (for the core process only; never give it to the owner to
  source, it sets `XDG_CONFIG_HOME`).
- The repository's own CLI is now API 3.0 and refuses those cores. Use the
  scratchpad wrappers `ag` (sonnet core) and `ag-opus`.
- The allow-list is the scratchpad file `cfg/culture-agents/allowlist.json`;
  the cores re-read it per request. One entry per task worktree.
- The OpenShell gateway and binary come from an earlier session's scratchpad
  (`43e5a03f-…/scratchpad/openshell-bin`, `osh/`). If that directory goes,
  dispatch stops.
- Run image `culture-agents-run:dogfood` is local only: the normal image plus
  the core's `node_modules` and a Python environment under
  `/usr/local/share/dogfood`. Rebuild it when a lockfile changes (build
  context in the scratchpad, `dogfood-image/`).
- A brief is built by the scratchpad script `brief.py <waves.json> <task>`,
  quoting the plan verbatim. Each run commits a `TASK-REPORT.md`; at merge it
  moves to `docs/d2/task-reports/<task>.md`.
- Merge gate per task: `git merge --no-ff --no-commit <runs/… branch>`, move
  the report, run `npm test`, lint and contract types in `core/`, the full
  Python suite, the three scans and markdownlint, then commit. Agents often
  skip the Python suite; expect to update a D1 test that encodes old
  behaviour.
- One worktree per task under `../.worktrees.culture-agents/agent-<task>`,
  because D1 allows one active run per repository path.
- For an OpenCode run, start from a history-free snapshot commit (see
  `snapshot/t15`): the agent otherwise reads the placeholder marker out of old
  diffs. Replay its commits onto the real branch at merge (cherry-pick the
  range after the snapshot commit).

### Owner's standing instructions from this run

- Choose the model per task without asking (opus: t6, t8, t13, t21, t23).
- One OpenCode run at a time. Never hard-timeout a local-model run.
- Run only `harness-smoke.py --stage config`; `--stage all` starts slow
  local-model probes and has failed unexplained twice.
- No real host name or address in any tracked file. The local gateway's role
  listing names real machines; keep that output out of commits and messages.
  `thor` and `spark` are both real mesh machines; the owner chose the Jetson
  Thor name as the example knowingly.

### Found by dogfooding

- Sandbox writes used chunks of exactly 1 MiB, the gateway's whole-message
  limit, so a repository over 1 MiB could not start a run. Fixed on the
  branch (`WRITE_CHUNK` is 512 KiB). Releases up to 0.15.3 have the bug.
- Text containing OpenShell's credential placeholder marker ends a run once a
  harness reads it. The marker is out of the working tree and
  `scripts/scan-secrets.py` fails on it; git history still holds it (plan
  risk r13).
- A failed turn collects nothing (plan risk r14, no task).
- The core has one model per harness for the whole daemon.
- Three OpenCode runs at once on one local model: two failed when the gateway
  lost its route to the serving machine. This led to the observability
  decision and to lobes-cli issue 348 (per-model load).

### Waiting on the owner

- Deviation `d1` (marker fix; t2 and t3 moved to host subagents) is still
  proposed. `d2` (observability) is approved.
- Whether to add `placement` and a typed "admission held" refusal to contract
  3.0 now; under the contract's own rule they cannot be minor additions
  later. Recommended: add both now.
- Two records still name the real chat server (`docs/d0/d1-acceptance.md`
  line 116 and one delivery record): redact or leave.
- t14: enabling publishing on a store with history publishes every past run
  from its first event; the broker address must be loopback.
- Langfuse: not installed on this host. The owner was asked whether I should
  bring it up from its own compose file; no answer yet. The live check of t29
  against a real Langfuse is mine to run on the host after t29 merges.
- Housekeeping: reject seven staged dev versions on npm, limit the `npm` and
  `pypi` environments to `main`, delete the stale remote branch
  `runs/d2-frame`, and two leftover local branches in the lobes-cli checkout.

### Next steps

1. Gate and merge t5, t12, t6 (t5 and t6 both touch `core/src/store/`).
2. Dispatch t7 (sonnet) and t11 (sonnet) after t6; then t8 (opus) after t7.
   Fold "unreadable run on the wire" into t8, as t4's report suggests.
3. When t15 and t29 end, gate them; t29's live Langfuse check follows.
4. Remove merged `runs/spark-…` result branches and the two smoke branches at
   the end, with the owner's go-ahead for forced deletes.
5. After wave 8 (t18 acceptance, t19 documents): bump the version, open the
   pull request through the `cicd` skill, and run the pre-PR review in
   OpenCode. Then `/validate-delivery` and `/summarize-delivery`.

## Start here in a new session

1. **Release workflow: stage on pull requests, publish on `main`.** Decided
   by the owner on 2026-11-25: a pull request stages a development version,
   `main` publishes the real one. The change is on branch
   `runs/npm-stage-on-pr` (0.15.1). See [The npm release](#the-npm-release).
2. **D2 framing** (fleet and recovery). Frame `d2-fleet-and-recovery`: 27
   explored surfaces, 27 claims (26 proposed, none confirmed by the owner)
   and 19 proposed honesty conditions. The announcement (`c1`) shows as
   confirmed only because `devague new` marks it so; the agent wrote it and
   the owner has not reviewed it. `/think` has added the before and after
   state, two success signals and the honesty conditions. Five hard questions
   wait for the owner; `q2` (which machines are the fleet) is blocking. Next:
   the owner's answers and confirmations (`devague review` lists them), then
   `converge` and `export`. See [Inputs for D2](#inputs-for-d2).

## What shipped

D0 and D1 of
[culture-agents#2](https://github.com/agentculture/culture-agents/issues/2):
a single-host control plane where an agent is dispatched, inspected, steered
and cancelled without chat, with truthful state after a restart.

| Pull request | What | Version |
| --- | --- | --- |
| #4 | D0 and D1 (all 17 plan tasks except `t5`'s merge) | 0.13.0 |
| #6 | validation records and the delivery summary | 0.13.1 |
| #7 | API version 2.0, the SonarCloud gate on `main`, ledger confirmations | 0.14.0 |
| #8 | closeout notes, `docs/current-spec.md` | 0.14.1 |
| #9 | delta `b5` approved, `b3` superseded | 0.14.2 |
| #10 | the core leaves the `0.0.0` placeholder; README and license in `core/` | 0.15.0 |

The devague flow is complete through `/summarize-delivery`. Deviations `d1`
to `d5`, lapses `l1` to `l15`, evidence `e1` to `e17` and deltas `b1` to `b5`
are approved by the owner; `b5` supersedes `b3`. Nothing in the ledger is
pending.

Last measured: 452 TypeScript tests pass (8 opt-in live checks skipped) and
1228 Python tests pass (9 skipped). The live acceptance stage passed 16 of 16
six times, the last at `92937aa` (PR #4's merge); it was not re-run after
that. Two hands-on sessions by another agent on the merged code ran eight
runs across both harnesses (submit, steer, cancel, busy and refusal probes),
all as the contract says; they are not in `docs/d0/d1-acceptance.md`.

## The npm release

- `@culture.dev/agents@0.15.0` is on npm, published by hand on 2026-11-25
  with the token held by `grant` (account `nachuo`, owner of the `culture.dev`
  org). It has no provenance attestation, because it did not come from CI.
  The registry copy was checked against a build of PR #10's commit with
  `scripts/npm_registry_matches.py`: `match`.
- npm also created a placeholder version `0.0.0-stage` ("Temporary package
  placeholder for staged publishing") during that publish. It is not
  `latest`. The owner may deprecate or remove it.
- The owner then configured the trusted publisher on npmjs.com (repository
  `agentculture/culture-agents`, workflow `publish.yml`, environment `npm`)
  and allowed both `npm publish` and `npm stage publish`. The first release
  through it was 0.15.1 on 2026-11-26 (PR #11's merge): `publish-npm`
  published with signed provenance, then PyPI published.
- On 2026-11-26 the owner created a second trusted publisher for a new
  `npm-stage` environment. The `npm-stage` job uses that environment, so a
  pull request no longer runs under the environment that may publish.
- `core/package.json`, the lockfile and `core/src/index.ts` now carry the
  same version as `pyproject.toml`. The version-bump script moves all of them
  together, and the release workflow fails when they differ.
- **Rule from the owner, still in force:** never publish to npm by hand
  without the owner's go-ahead at that moment.

### Stage on pull requests, publish on `main`

What `npm help stage` (npm 11.21.1, the version the workflow pins) says:

- `npm stage publish` puts a version in the registry where it is not publicly
  available. It needs no 2FA and works with any token type, trusted
  publishing included. It accepts `--provenance`, `--tag`, `--access` and
  `--dry-run`.
- `npm stage approve <stage-id>` and `npm stage reject <stage-id>` need the
  maintainer's 2FA. CI cannot do either.
- **A staged version and a published version share one version index: a
  version that is staged cannot be published, and the reverse.**
- Several versions of one package can be staged at once. A pre-release
  version needs an explicit `--tag`.

The design question that follows from the third point: a pull request cannot
stage the version that `main` will then publish. The two workable shapes are:

- **Stage a development version on the pull request**, for example
  `<version>-dev.<run number>` with `--tag dev`, as the `test-publish` job
  does on TestPyPI, and publish the real version on `main`. Staged
  development versions stay until someone rejects them with 2FA; whether npm
  expires them is not known.
- **Stage the real version on the pull request and approve it after the
  merge.** `main` then publishes nothing and only checks that the approved
  version matches. This breaks as soon as a pull request gets a second
  commit, because the same version cannot be staged twice.

The owner chose the first shape on 2026-11-25. The `npm-stage` job in
`.github/workflows/publish.yml` implements it for same-repository pull
requests: it stages `<version>-dev.<run number>.<run attempt>` with
`--tag dev` through the staging trusted publisher (`environment: npm-stage`,
`id-token: write`). The run attempt is in the version because a re-run cannot
stage the same version twice. The fork-safe `npm-dry-run` job stays.

Checked against npm's documentation (`docs.npmjs.com/staged-publishing`,
`/trusted-publishers`, `/cli/v11/commands/npm-stage`):

- `npm stage publish` works with a trusted publisher. `approve`, `reject`,
  `list` and `view` need interactive authentication and cannot use it.
- The docs state no expiry for staged versions and no limit on their number.
  npmjs.com can reject up to 100 at once.
- Staged publishing needs npm 11.15.0 or later and Node 22.14.0 or later.
- `0.0.0-stage` is the placeholder npm publishes when a package is first
  staged; the docs do not say whether it can be removed.

The first pull request that runs this job is also the first use of the
trusted publisher.

## Owner decisions in force

- TypeScript core `@culture.dev/agents` on npm, Python `agents` CLI on PyPI
  built on agentfront; the CLI checks the API version on connect. The control
  API is version 2.0.
- Runtime dependencies: `agentfront` and `jsonschema`. Others need approval.
- Harnesses run inside an NVIDIA OpenShell sandbox: Claude Code through the
  Vercel AI SDK adapter, OpenCode v2 through its server API. Codex is not
  verified.
- A run's repository enters the sandbox as a git bundle; commits return into
  `runs/<id>`. The host checkout is never written by a harness.
- Sibling repositories were changed by branch and pull request for the D0 and
  D1 work only. That permission ended with it: cross-repo work goes back to
  issues.
- A SonarCloud issue is marked Accepted only when the owner approved that
  issue. One was (S5332, the plain-HTTP default of the local model gateway).
  Findings are otherwise fixed in code.
- Local-model runs (OpenCode `gateway/cortex`, colleague) get no hard
  timeout and are resumed, not restarted.

## Open items

- `t5`: agentculture/culture#532 (the workspace map) is open on the culture
  repository.
- The `npm`, `pypi` and `testpypi` environments have no protection rules and
  no branch policy. Now that staging has its own environment, `npm` and
  `pypi` can be limited to the `main` branch (the owner's setting).
- Staged development versions wait for the owner's `npm stage reject`:
  `0.15.1-dev.43.1` to `0.15.1-dev.47.1` from PR #11, plus one per push of
  each later pull request.
- `culture-agents-run:dev`, the core's default image, points at an untested
  rebuild. The tested image is tagged `:sonar`; `:dev-prev` is the image of
  the first four live runs.
- The published explainer
  (<https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7>) was rebuilt on
  2026-11-26 with one tab per phase and pull request; its `Map` tab is the
  2026-11-24 page, kept unchanged.
- Local branches from this work that are merged and can be deleted:
  `runs/d0-d1-spec`, `runs/d0-d1-delivery`, `runs/d1-main-green`,
  `runs/d1-closeout`, `runs/d1-ledger-b5`, `runs/npm-bootstrap`. Three older
  local branches belong to the owner.

## Known gaps in the code

- A cancel whose grace period expires during retention cleanup leaves the
  sandbox without a retention record.
- The worker's `conflict` reply on a refused append has no test (reachable
  only in a race).
- `core/test/daemon/lifecycle.test.ts`, "SIGTERM stops cleanly…", failed once
  in CI's coverage run and passed on re-run. The cause is not known.
- `runs result` returns concatenated text; the contract names no place for a
  harness's final summary.
- `harness-smoke --stage live` fails on OpenCode when the local `cortex`
  model is unavailable.

## Inputs for D2

- [#5](https://github.com/agentculture/culture-agents/issues/5) holds the
  review follow-ups and four later comments: the five unknowns parked on the
  frame (daemon supervision, secrets in run logs, duplicate submit, local
  models from inside the sandbox, OpenShell churn), the broker question
  (MQTT), the flaky test, and two findings from the hands-on tests (run
  branches and worktrees accumulate with no review or cleanup path; steer is
  not preemption).
- Live control of a worker that survived a core restart is the main item: D1
  reports such a run from disk only.

## Machine state

- Commits use `git -c user.name="Ori Nachum" -c user.email=<the owner's
  email>` because no git identity is configured, and end with the two
  trailers used throughout `git log`.
- `.eidetic/memory/default__public.jsonl` is modified by `/recall` and is
  deliberately never committed.
- The OpenShell 0.1.10 gateway used for the live runs was started from a
  session scratch directory and does not survive that session's cleanup. Its
  providers hold real credentials; three (`codex`, `claude-code`,
  `claude-npm`) are unused. A new session that needs live runs must set up a
  gateway again (`docs/d0/d1-acceptance.md` records how the runs were made).
  **Never source a gateway environment file into a shell used for other
  tools**: it changes `XDG_CONFIG_HOME`, after which `gh` reports it is not
  logged in and OpenCode cannot find its running service.
- To use the npm token without showing it: a temporary npmrc holding
  `//registry.npmjs.org/:_authToken=${NPM_ACCESS_TOKEN}` and
  `grant run --inject NPM_ACCESS_TOKEN=NPM_ACCESS_TOKEN -- npm --userconfig <that file> …`.
  The local npm is 9.2.0 and does not know `npm stage`; use
  `npx npm@11.21.1`.
- Sibling worktrees from this work: `~/git/.worktrees.culture/workspace-map`
  (PR #532, still needed) and `~/git/.worktrees.agentfront/public-cli-hooks`
  (PR #60 is merged; kept only because a local tool log in it is modified).
