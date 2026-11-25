# Handoff: issue #2 reorganization, D0 + D1 build

Written 2026-11-25 for a context compaction. This is working state, not a
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

- Repo `/home/ori/git/culture-agents`, local branch `runs/d0-d1-spec`, about 50
  commits ahead of `main`. **Nothing is pushed.** No PR exists for this repo.
- One file is modified and deliberately never committed:
  `.eidetic/memory/default__public.jsonl` (a recall counter bumped by `/recall`).
- Commits use `git -c user.name="Ori Nachum" -c user.email=<the owner's email>`
  because no git identity is configured, and end with the two trailers used
  throughout `git log`.

## Method in force

devague flow: scope, think, challenge, spec-to-plan, assign-to-workforce.
Frame and plan slug `issue-2-cross-repo-reorganization`, both converged.
Each plan task runs in a subagent in its own worktree under
`/home/ori/git/.worktrees.culture-agents/<name>` on a `runs/<name>` branch.
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
- Deviations d1 to d4 are approved.

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
| t16 D1 acceptance suite and live run | not started; owned by the main agent |
| t17 boundary audit | not started |

Last measured on the branch: 918 Python tests pass; 343 TypeScript tests pass,
with the opt-in live checks skipped.

## In flight

Nothing. No subagent is running and the only worktree is the primary checkout.
After the integration fixes merged, `npm test` passed 6 of 6 consecutive runs
(343 pass). Lapse l9 records that two worker tests had their deadlines
loosened without the cause of their earlier failures being isolated.

## Next steps

1. t16: `tests/acceptance/d1/` driving the real CLI against the real core with
   the culture server stopped; mock stage always, live stage reported NOT
   VERIFIED when unavailable; record the live run in
   `docs/d0/d1-acceptance.md`. Targets: submit returns a run id in under 2 s;
   two harnesses complete a task; steer changes output; cancel reaches
   `cancelled` in under 10 s; after `kill -9` and restart every run reports a
   state and none an invented success.
2. t17: boundary audit against `docs/d0/sibling-baseline.txt`, written to
   `docs/d0/boundary-audit.md`.
3. Version bump, `ask-colleague review`, then the PR through the `cicd` skill.
   Then `/validate-delivery` and `/summarize-delivery`.

## Open items for the owner

- agentculture/agentfront#60 (public `run_cli`, `meta_verb`,
  `add_learn_section`): reviewed as request-changes. CI fails on two Sonar
  S9073 issues; `run_cli` can return a non-int; a conflicting `configure`
  escapes as a traceback; `explain --json` at the root prints markdown. Offer
  made to send the subagent back; no answer yet.
- Obligation o15 names the old package `@culture.dev/agents-core`; o18 is the
  corrected one. Both are pending: reject o15, confirm o18.
- Nine lapses (l1 to l9) are filed and await adjudication.
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
  `/home/ori/git/.worktrees.culture/workspace-map` (PR #532) and
  `/home/ori/git/.worktrees.agentfront/public-cli-hooks` (PR #60). Other
  worktrees in those repos belong to the owner.
- `/home/ori/git/CLAUDE.md` now points at the workspace map.
- Published explainer: <https://claude.ai/artifact/RoWVa9am389rfeHhFxEpD7>,
  source in the scratch directory as `issue-2-reorg-map.html`. It predates the
  OpenCode and OpenShell decisions.
