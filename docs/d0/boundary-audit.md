# Boundary audit

Plan task t17, run on 2026-11-25 before the final PR. It compares every
sibling checkout with `docs/d0/sibling-baseline.txt` (captured
2026-11-24T22:09:38Z, before any sibling worktree was created) and lists what
this work changed outside `culture-agents`.

## Result

| Rule | Result | Evidence |
| --- | --- | --- |
| No file under `embodiment` changed | holds | Same HEAD, branch and status as the baseline; no file in the checkout has a modification time after the baseline |
| No commit pushed to `cultureagent` or `agent-lifecycle` | holds | Each repo's GitHub event feed since the baseline holds one `IssuesEvent` (the tracking issue) and no push; their branch lists hold no branch from this work |
| Every sibling change is on a work-scoped branch, in a worktree under `../.worktrees.<repo>/`, with a PR | holds | Two changes, both listed below |
| Every difference from the baseline in a primary checkout is attributed | holds | One difference in 14 checkouts, attributed below |

## Method

For each of the 14 repositories in the baseline, the same three things were
captured again: `HEAD` and branch, `git status --porcelain`, and
`git worktree list`. The two captures were compared with `diff`.

A porcelain status cannot show a second edit to a file that was already
modified at the baseline. So each checkout was also searched for files
modified after the baseline time, leaving out `.git`, `node_modules`, `.venv`
and `__pycache__`.

Pushes were checked on GitHub, not from the local checkouts, so the audit
itself fetched nothing into a sibling: the event feed and branch list of
`cultureagent`, `agent-lifecycle` and `embodiment`, and the two pull requests.

## Differences from the baseline

The comparison found one difference across the 14 checkouts:

| Repo | Difference | Caused by |
| --- | --- | --- |
| culture | New worktree `/home/ori/git/.worktrees.culture/workspace-map` on `docs/workspace-map` (`afadaa1`) | This work (plan task t5) |

In every checkout, including `culture`, the HEAD commit, the branch and the
status lines are identical to the baseline. No working file in any of the 14
checkouts, or in `agentfront`, was modified after the baseline time. The
owner's uncommitted work that the baseline recorded (12 of the 14 checkouts
were dirty) is unchanged, and no concurrent change by the owner appeared in these
checkouts during the work.

Inside `.git`, two primary checkouts changed, both from creating a worktree
and pushing its branch:

| Repo | Changed under `.git` | Caused by |
| --- | --- | --- |
| culture | `config` (upstream of `docs/workspace-map`), `worktrees/`, `objects/`, `FETCH_HEAD` | This work: `git worktree add`, a fetch, and the push of the branch |
| agentfront | `config` (upstream of `feat/public-cli-hooks`), `worktrees/`, `objects/`, `FETCH_HEAD` | This work, the same steps |

`agentfront` is not in the baseline. It was added to the work later, with the
owner's approval, so its primary checkout has no earlier capture to compare
with. Its state now: branch `feat/sharpen-testable-collab` at `9d0df84`, one
modified file (`.agex/data/pr/events.jsonl`) and three untracked paths, none
modified after the baseline time.

## What this work changed outside culture-agents

| Repo | Branch | Worktree | Pull request | State |
| --- | --- | --- | --- | --- |
| culture | `docs/workspace-map` | `/home/ori/git/.worktrees.culture/workspace-map` | [agentculture/culture#532](https://github.com/agentculture/culture/pull/532) | open, one commit `afadaa1` |
| agentfront | `feat/public-cli-hooks` | `/home/ori/git/.worktrees.agentfront/public-cli-hooks` | [agentculture/agentfront#60](https://github.com/agentculture/agentfront/pull/60) | open, one commit `3e220ea`, reviewed as request-changes |

These are the only two remote branches this work pushed. Neither pull request
is merged.

Other changes outside this repository:

- **Twelve tracking issues**, one each on culture-chat, agentirc, irc-lens,
  culture, culture-rules, embodiment, colleague, associate, steward,
  guildmaster, cultureagent and agent-lifecycle, linked from
  [issue #2](https://github.com/agentculture/culture-agents/issues/2#issuecomment-7146902139).
  An issue is not a change to a repository's files.
- **`/home/ori/git/CLAUDE.md`**, the workspace-root prompt file, which is not
  in any repository: one line now points at `culture/docs/workspace-map.md`.
- **Tool files in the two worktrees:** an untracked `.devex/` directory in the
  culture worktree and a modified `.agex/data/pr/events.jsonl` in the
  agentfront worktree, both written by the PR tooling. Neither is committed.

## Limits

- The baseline records status lines, not file contents. The claim that no
  file changed rests on modification times, which a tool can preserve or
  reset.
- The culture commit was made with git hooks skipped (deviation d2,
  approved): the hooks were run separately and passed.
- GitHub's event feed covers recent events only. It was read one day after
  the baseline.
