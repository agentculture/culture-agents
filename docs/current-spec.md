# Current spec — what the app does today

## Coverage boundary

This projection is complete only over the behavior ledger: 1 of 1 plan have a ledgered delivery (`issue-2-cross-repo-reorganization`), spanning `2026-11-24T22:42:35Z` (plan `issue-2-cross-repo-reorganization`) through `2026-11-24T22:42:35Z` (plan `issue-2-cross-repo-reorganization`).
Anything predating this boundary, or belonging to an unledgered frame, is not reflected here by construction.

## Current behavior

- The second required D1 harness is OpenCode v2, not Codex; Codex is reported as not verified. Both Claude Code and OpenCode passed the live stage (submit, steer, cancel, kill -9 and restart). (`issue-2-cross-repo-reorganization:b1`, amended)
  - provenance: caused by `d1` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: integration — execution: pass (run 2026-11-25 @ 92937aa)
- A run whose turn completed but whose commits could not be collected keeps its sandbox for 7 days (retainFailedSandboxDays, 0 to 90) and its failure message says how to fetch the work; the sandbox is not deleted at that terminal state. All other finished runs' sandboxes are still deleted. (`issue-2-cross-repo-reorganization:b2`, amended)
  - provenance: caused by `c57` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: integration — execution: pass (run 2026-11-25 @ 92937aa)
- Without `XDG_RUNTIME_DIR` the control socket is ${`XDG_STATE_HOME`:-$HOME/.local/state}/culture-agents/core.sock, not a path under /tmp. contract/api.json's `socket_fallback` changed with it and the API version stayed 1.0. (`issue-2-cross-repo-reorganization:b3`, amended)
  - provenance: caused by `c42` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-25 @ 92937aa)
- The CLI validates every core response against the contract schemas and treats an invalid one as an internal error (exit 2); text mode shows control characters in run-originated text as visible escapes; runs attach survives a core restart. (`issue-2-cross-repo-reorganization:b4`, added)
  - provenance: caused by `c42` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-25 @ 92937aa)

## Ledger status

- proposed deltas awaiting adjudication: 0
- rejected deltas (excluded from this projection): 0
- retired lineages (superseded with no live replacement): 0
