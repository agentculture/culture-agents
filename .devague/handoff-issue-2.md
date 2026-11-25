# Handoff: issue #2 reorganization, after D0 and D1

Written 2026-11-25, after D0 and D1 merged. This is working state, not a
design document. The authoritative records are:

- the frame and plan under `.devague/` (slug
  `issue-2-cross-repo-reorganization`), with the spec in `docs/specs/` and
  the plan in `docs/plans/`;
- `docs/d0/` (inventory, matrix, decisions, probe, acceptance record,
  boundary audit);
- the delivery summary
  `docs/deliveries/2026-11-24-issue-2-cross-repo-reorganization.md` and the
  derived `docs/current-spec.md`.

## What shipped

D0 and D1 of
[culture-agents#2](https://github.com/agentculture/culture-agents/issues/2):
a single-host control plane where an agent is dispatched, inspected, steered
and cancelled without chat, with truthful state after a restart.

| Pull request | What | Merged as |
| --- | --- | --- |
| #4 | D0 and D1 (all 17 plan tasks except `t5`'s merge) | `92937aa`, 0.13.0 |
| #6 | validation records and the delivery summary | `7de103b`, 0.13.1 |
| #7 | API version 2.0, the SonarCloud gate on `main`, ledger confirmations | `46ed39a`, 0.14.0 |

`main` is green at `46ed39a`: the `Tests` workflow passes and SonarCloud
lists 0 open issues on the branch. PyPI has 0.14.0. Nothing is on npm.

The devague flow is complete through `/summarize-delivery`. Deviations `d1`
to `d5`, lapses `l1` to `l15`, evidence `e1` to `e17` and deltas `b1` to `b4`
are approved by the owner. Delta `b5` (API 2.0, replacing `b3`) is proposed.

Last measured at `92937aa` plus the PR #7 changes: 452 TypeScript tests pass
(8 opt-in live checks skipped), 1228 Python tests pass (9 skipped), and the
live acceptance stage passed 16 of 16 six times, the last at `92937aa`. The
live stage was not re-run after PR #7.

## Owner decisions in force

- TypeScript core `@culture.dev/agents` on npm, Python `agents` CLI on PyPI
  built on agentfront; the CLI checks the API version on connect.
- Runtime dependencies: `agentfront` and `jsonschema`. Others need approval.
- Harnesses run inside an NVIDIA OpenShell sandbox: Claude Code through the
  Vercel AI SDK adapter, OpenCode v2 through its server API. Codex is not
  verified.
- A run's repository enters the sandbox as a git bundle; commits return into
  `runs/<id>`. The host checkout is never written by a harness.
- **Never publish to npm without the owner's go-ahead at that moment.**
  `core/package.json` stays `0.0.0` until the owner bootstraps the package
  name; Trusted Publishing takes over after that.
- Sibling repositories were changed by branch and pull request for this work
  only. That permission ended with it: cross-repo work goes back to issues.
- A SonarCloud issue is marked Accepted only when the owner approved that
  issue. One was (S5332, the plain-HTTP default of the local model gateway).
- Local-model runs (OpenCode `gateway/cortex`, colleague) get no hard
  timeout and are resumed, not restarted.

## Open items

- `t5`: agentculture/culture#532 (the workspace map) is open on the culture
  repository.
- npm bootstrap of `@culture.dev/agents`. Until it happens, the
  npm-before-PyPI order in the release workflow has never run.
- `culture-agents-run:dev`, the core's default image, points at an untested
  rebuild. The tested image is tagged `:sonar`; `:dev-prev` is the image of
  the first four live runs.
- Unused providers on the session's OpenShell gateway: `codex`,
  `claude-code`, `claude-npm`.
- The published explainer
  (<https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7>) predates the OpenCode
  and OpenShell decisions and everything after them.

## Known gaps in the code

- A cancel whose grace period expires during retention cleanup leaves the
  sandbox without a retention record.
- The worker's `conflict` reply on a refused append has no test (reachable
  only in a race).
- `runs result` returns concatenated text; the contract names no place for a
  harness's final summary.
- `harness-smoke --stage live` fails on OpenCode when the local `cortex`
  model is unavailable.

## Inputs for D2

D2 (fleet and recovery) is the next gate and is not started. It begins with
its own scope, think and challenge pass. Material already collected:

- Review follow-ups in
  [#5](https://github.com/agentculture/culture-agents/issues/5).
- Five unknowns parked on the frame: how the daemon is supervised; redaction
  of secrets in run logs; whether submit deduplicates on the idempotency key;
  whether a sandboxed harness can reach the local model gateway; OpenShell
  API churn.
- Live control of a worker that survived a core restart (D1 reports such a
  run from disk only).
- Whether event-log polling and cross-machine transport should move to a
  broker such as MQTT. D1's loops do not need one.

## Machine state

- Commits use `git -c user.name="Ori Nachum" -c user.email=<the owner's
  email>` because no git identity is configured, and end with the two
  trailers used throughout `git log`.
- `.eidetic/memory/default__public.jsonl` is modified by `/recall` and is
  deliberately never committed.
- The OpenShell 0.1.10 gateway used for the live runs was started from a
  session scratch directory and does not survive that session's cleanup. Its
  providers hold real credentials. `source <scratch>/osh/env.sh` selects it;
  **do not run `gh` in a shell that sourced it**, because it changes
  `XDG_CONFIG_HOME`.
- Sibling worktrees from this work: `~/git/.worktrees.culture/workspace-map`
  (PR #532, still needed) and `~/git/.worktrees.agentfront/public-cli-hooks`
  (PR #60 is merged; kept only because a local tool log in it is modified).
