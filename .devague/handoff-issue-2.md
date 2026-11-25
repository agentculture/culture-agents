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

## Start here in a new session

Two pieces of work are ready to start. The owner chooses the order.

1. **Release workflow: stage on pull requests, publish on `main`.** The
   owner's instruction (2026-11-25): "PR should be stage, and main should be
   publish." See [The npm release](#the-npm-release) for what is known and the
   design question to settle first. This file's own update rides on that
   branch (`runs/npm-stage-on-pr`), unmerged, so that no release is made for a
   note alone.
2. **D2 scoping** (fleet and recovery). Not started. It begins with its own
   scope, think and challenge pass. See [Inputs for D2](#inputs-for-d2).

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
  and allowed both `npm publish` and `npm stage publish`. **No release has
  gone through it yet.** The first merge that bumps the version is its first
  test: if the npm step fails, PyPI is not published either.
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

The first shape fits the owner's wording. Confirm it with the owner, check
the commands against npm's own documentation, then change the `npm-dry-run`
job in `.github/workflows/publish.yml` (it needs `environment: npm` and
`id-token: write` to use the trusted publisher) and update
`tests/test_publish_workflow.py`.

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
- Whether to put a required reviewer on the repository's `npm` environment,
  now that CI may publish directly.
- `culture-agents-run:dev`, the core's default image, points at an untested
  rebuild. The tested image is tagged `:sonar`; `:dev-prev` is the image of
  the first four live runs.
- The published explainer
  (<https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7>) predates the OpenCode
  and OpenShell decisions and everything after them.
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
