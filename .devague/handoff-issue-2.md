# Handoff: issue #2 reorganization, D0 + D1 build

Written 2026-11-25 for a context compaction, updated the same day after t16
and t17. This is working state, not a
design document. The authoritative records are the frame and plan under
`.devague/`, the spec and plan under `docs/specs/` and `docs/plans/`, and
`docs/d0/`.

## Goal

Deliver D0 and D1 of
[culture-agents#2](https://github.com/agentculture/culture-agents/issues/2):
a single-host control plane where an agent is dispatched, inspected, steered
and cancelled without chat, with truthful state after a restart. D2 to D6 are
out of scope and tracked by issues on the sibling repos.

## Where the work is

- Repo `~/git/culture-agents`, local branch `runs/d0-d1-spec`, about 55
  commits ahead of `main`, version 0.13.0. Pushed; PR #4 is open.
- One file is modified and deliberately never committed:
  `.eidetic/memory/default__public.jsonl` (a recall counter bumped by `/recall`).
- Commits use `git -c user.name="Ori Nachum" -c user.email=<the owner's email>`
  because no git identity is configured, and end with the two trailers used
  throughout `git log`.

## Method in force

devague flow: scope, think, challenge, spec-to-plan, assign-to-workforce.
Frame and plan slug `issue-2-cross-repo-reorganization`, both converged.
Each plan task runs in a subagent in its own worktree under
`~/git/.worktrees.culture-agents/<name>` on a `runs/<name>` branch.
The main agent merges with `--no-ff` only if tests pass before and after, then
removes the worktree. Subagents never run `devague`; the main agent files
lapses and deviations the moment they surface. Briefs quote the task from
`devague plan waves --json` verbatim.

## Owner decisions (all recorded on the frame)

- TypeScript core published to npm as `@culture.dev/agents`; Python `agents`
  CLI on PyPI built on agentfront; two packages, API version check on connect.
- agentfront is an approved runtime dependency; further ones need approval.
- Harnesses run inside an NVIDIA OpenShell sandbox. Claude Code goes through
  the Vercel AI SDK adapter. The second harness is OpenCode v2 through its own
  server API (`opencode serve`). Codex is not verified and out of D1.
- Working tree: git bundle into the sandbox; the host fetches commits over SSH
  into `runs/<id>`. The host checkout is never written by a harness.
- After a daemon restart, surviving workers keep running and are reported from
  disk without live control.
- First npm publish waits until D1 passes: one manual bootstrap with
  `NPM_ACCESS_TOKEN` from `grant` (authenticates as `nachuo`), then the owner
  sets up Trusted Publishing. Never publish without an explicit go-ahead.
- Sibling repos may be changed by branch and PR for this work only.
  culture-nodes is out of scope; embodiment's opencode-subagent plan is paused.
- Deviations d1 to d5 are approved.

## Plan status

| Task | State |
| --- | --- |
| t1 probe | done (`docs/d0/probe.md`, `spikes/d1-probe/`) |
| t2 inventory | merged |
| t3 matrix and decisions | merged |
| t4 tracking issues | done: 12 issues posted and linked from issue #2 |
| t5 culture workspace map | PR open: agentculture/culture#532 |
| t6 contract | merged, plus the TS contract kit (deviation d3) |
| t7 TS scaffold and CI | merged |
| t8 daemon | merged |
| t9 run store and worker | merged |
| t10 sandbox provider | merged |
| t11 harness adapters | merged; both harnesses passed live, twice each |
| t12 orchestration | merged |
| t13 CLI on agentfront | merged |
| t14 prompt files | merged |
| t15 release workflow | merged |
| integration fixes | merged (control-channel delivery, truthful steer records, long run ids, real registry in the daemon bin `culture-agents-core`) |
| t16 D1 acceptance suite and live run | done: `tests/acceptance/d1/`, `docs/d0/d1-acceptance.md`; two full runs, 16 passed each |
| t17 boundary audit | done: `docs/d0/boundary-audit.md` |
| version bump | done: 0.13.0 |

Last measured on the branch (commit `da75696`): 1228 Python tests pass, 9
skipped (8 of them the live acceptance checks, reported NOT VERIFIED without
the opt-in); 446 TypeScript tests pass, 8 opt-in live checks skipped.

t16 found and fixed two core defects: a finished run reported no branch and no
commits, and a cancel waited a fixed 4.5 s before recording `cancelled`
(OpenCode took 11.2 s against the 10 s target; now 8.6 to 8.9 s).

## In flight

PR [agentculture/culture-agents#4](https://github.com/agentculture/culture-agents/pull/4)
is open and pushed. Reviews so far, all acted on:

- colleague CLI (GLM-5.3-Flash): three fixes.
- `/code-review` of PR #4 by three independent reviewers: one must-fix and
  eleven should-fix, all twelve fixed with tests (sandbox reclaim, unreadable
  runs, control races, state-directory lock, CLI and contract fixes), and the
  live stage re-run afterwards (16 of 16).
- OpenCode with `gateway/cortex`, session `ses_dee4a93efffeSMHElqr4XqBXtD`:
  nine nits, four fixed. Its report is `opencode-review3.txt` in the session
  scratch directory.

- A second fix round took the twelve larger items left over from those
  reviews plus the owner's decisions (second runtime dependency `jsonschema`,
  failed work kept 7 days, bounded waits, agentfront 0.22 public API,
  per-line portability waiver, version-bump mirrors). Live stage re-run: 16
  of 16. Deferred follow-ups are in culture-agents#5.
- OpenCode with `gateway/cortex` reviewed that round (`opencode-review4.txt`
  in the scratch directory): no must-fix, one should-fix (unbounded OpenCode
  mid-turn reads and interrupt) and four nits. All five are fixed; the
  worker's refusal reply has no test (reachable only in a race).

SonarCloud analyses the PR since 2026-11-25 (scan, quality gate and an
open-issues gate in the `test` job; Python and TypeScript coverage). The
first scan had 240 open issues; there are none now and every check on the PR
passes (commit `da75696`). One issue was accepted by the owner (the
plain-HTTP default of the local model gateway, S5332), the generated contract
types are excluded from analysis, and the rest were fixed in code. Notable
changes from that round: sequential loops run on `core/src/util/sequence.ts`;
the socket fallback moved from `/tmp` to the per-user state directory (a
contract change); the run image declares uid 1000 and installs Node.js from a
signed apt source; `toHarnessSandboxProvider` is removed.

A fifth live run passed 16 of 16 on the rebuilt image, selected with
`CULTURE_AGENTS_RUN_IMAGE=culture-agents-run:sonar`. The tag
`culture-agents-run:dev`, which the core uses by default, still points at
an older untested rebuild; `:dev-prev` is the image of the first four live
runs. The owner has not said whether to move `:dev`.

The SonarCloud skill can mark an issue Accepted with the token held by
`grant`; do that only for an issue the owner has approved.

## Next steps

1. Ask the owner whether to move `culture-agents-run:dev` to the tested image.
2. (done) SonarCloud is clean.
3. Wait for the owner to merge PR #4.
4. After the merge: `/validate-delivery`, then `/summarize-delivery`.

## Open items for the owner

- The first npm publish was to wait until D1 passes. It now passes. `core/`
  is still `0.0.0`, so a merge publishes nothing to npm until the owner says
  go.
- Nine lapses (l1 to l9) are filed and await adjudication; l10 to l12 are
  approved.
- Whether to delete the unused `codex`, `claude-code` and `claude-npm`
  providers on the OpenShell gateway.

## Known limits and follow-ups

- `runs result` returns concatenated text; the contract names no place for a
  harness's final summary. Left as is for D1.
- The release workflow does not yet handle a version already on npm, which is
  the state after the manual bootstrap. Port the check from
  `embeddings-tumbler/.github/workflows/publish.yml` before the first CI
  release.
- After agentfront 0.22 is released: replace the private imports in
  `culture_agents/cli/__init__.py` and `_app.py`, widen the pin from
  `>=0.21.3,<0.22`.
- `culture_agents/cli/_commands/doctor.py` docstring still says "this
  template".
- The provider profiles and run policy in `core/policy/` pass lint but were
  never imported on a gateway. The image carries the Claude bridge in two
  locations because the gateway's stock profile allows only one path.
- `harness-smoke --stage live` fails on OpenCode because the local `cortex`
  model is unavailable; it fails the same without this work.
- The culture PR's commit was made with hooks skipped (approved, d2) because
  the installed pre-commit environment cannot build its markdownlint hook.

## Machine state

- OpenShell 0.1.10 gateway running as a user process, pid 348049 at the time
  of writing, on `https://127.0.0.1:17670`, started from the session scratch
  directory `/tmp/claude-1000/-home-ori-git-culture-agents/43e5a03f-1dac-4347-8d01-3b31ba5ae604/scratchpad/`
  (`openshell-bin/` binaries, `osh/` state, `osh/env.sh`). `source osh/env.sh`
  to use the `openshell` CLI. **Do not run `gh` in a shell that sourced it**:
  it changes `XDG_CONFIG_HOME` and `gh` then reports it is not logged in.
- Providers on the gateway hold real credentials: `claude-sub` (subscription
  token from `grant` `CLAUDE_CODE_OAUTH_TOKEN`), `lobes` (local model gateway
  key), plus unused `claude-code`, `claude-npm`, `codex`.
- Docker images: `culture-agents-run:dev` and `culture-agents-probe:0.1` to
  `0.5`. No sandboxes exist.
- Sibling worktrees created by this work:
  `~/git/.worktrees.culture/workspace-map` (PR #532) and
  `~/git/.worktrees.agentfront/public-cli-hooks` (PR #60). Other
  worktrees in those repos belong to the owner.
- `~/git/CLAUDE.md` now points at the workspace map.
- Published explainer: <https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7>,
  source in the scratch directory as `issue-2-reorg-map.html`. It predates the
  OpenCode and OpenShell decisions.
