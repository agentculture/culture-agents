# Current spec — what the app does today

## Coverage boundary

This projection is complete only over the behavior ledger: 2 of 2 plans have a ledgered delivery (`d2-fleet-and-recovery`, `issue-2-cross-repo-reorganization`), spanning `2026-11-24T22:42:35Z` (plan `issue-2-cross-repo-reorganization`) through `2026-11-26T18:20:06Z` (plan `d2-fleet-and-recovery`).
Anything predating this boundary, or belonging to an unledgered frame, is not reflected here by construction.

## Current behavior

- Operator questions work end to end with the stub harness only; the Claude Code and OpenCode drivers have no ask path and report answer as unsupported (`d2-fleet-and-recovery:b1`, amended)
  - provenance: caused by `d3` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-27 @ b4d7723)
- A run directory the core cannot read is skipped by the API listing instead of being listed as unreadable (`d2-fleet-and-recovery:b2`, amended)
  - provenance: caused by `c55` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - ⚠ unproven: failing evidence on record
    - evidence: observation — coverage: fail (run 2026-11-27 @ b4d7723)
- The trace endpoint must be a loopback address and a redirect is never followed; any other address stops the core at start (owner decision of 2026-11-27) (`d2-fleet-and-recovery:b3`, added)
  - provenance: caused by `c69` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - ⚠ unproven: no passing evidence on record
    - evidence: none on record
- An answer's delivery is bounded at 30 seconds and a harness may withdraw a question; a hung delivery no longer suspends the question limit (from the code review of pull request 15) (`d2-fleet-and-recovery:b4`, added)
  - provenance: caused by `c7` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-27 @ b4d7723)
- Contract 3.0 lets placement be reported as supported and has a typed `admission_held` refusal; schema only, nothing returns it (owner approval of 2026-11-27, task t30) (`d2-fleet-and-recovery:b5`, added)
  - provenance: caused by `c8` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - ⚠ unproven: no passing evidence on record
    - evidence: none on record
- The capability report reads the model gateway's admit field for OpenCode, on loopback only, capped at 64 KiB and 1 second (owner approval of 2026-11-27, task t31) (`d2-fleet-and-recovery:b6`, added)
  - provenance: caused by `c8` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - ⚠ unproven: no passing evidence on record
    - evidence: none on record
- Injected secrets are not inherited by any worker, host command or sandbox, but stay readable in the core's own /proc environment to processes of the same user; the documents say so (`d2-fleet-and-recovery:b7`, amended)
  - provenance: caused by `c44` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-27 @ b4d7723)
- Retention removes every worker-written terminal state (succeeded, failed, cancelled, `timed_out`, unanswered), never unknown; the documents were changed to match the code (`d2-fleet-and-recovery:b9`, amended)
  - provenance: caused by `c58` — plan `d2-fleet-and-recovery`, frame `d2-fleet-and-recovery`
  - ⚠ unproven: no passing evidence on record
    - evidence: none on record
- The second required D1 harness is OpenCode v2, not Codex; Codex is reported as not verified. Both Claude Code and OpenCode passed the live stage (submit, steer, cancel, kill -9 and restart). (`issue-2-cross-repo-reorganization:b1`, amended)
  - provenance: caused by `d1` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: integration — execution: pass (run 2026-11-25 @ 92937aa)
- A run whose turn completed but whose commits could not be collected keeps its sandbox for 7 days (retainFailedSandboxDays, 0 to 90) and its failure message says how to fetch the work; the sandbox is not deleted at that terminal state. All other finished runs' sandboxes are still deleted. (`issue-2-cross-repo-reorganization:b2`, amended)
  - provenance: caused by `c57` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: integration — execution: pass (run 2026-11-25 @ 92937aa)
- The CLI validates every core response against the contract schemas and treats an invalid one as an internal error (exit 2); text mode shows control characters in run-originated text as visible escapes; runs attach survives a core restart. (`issue-2-cross-repo-reorganization:b4`, added)
  - provenance: caused by `c42` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-25 @ 92937aa)
- Without `XDG_RUNTIME_DIR` the control socket is ${`XDG_STATE_HOME`:-$HOME/.local/state}/culture-agents/core.sock, not a path under /tmp. The control API version is 2.0 since release 0.14.0: by the contract's rule the socket change is a major one, and a 1.x client and a 2.0 core refuse each other with exit 2 naming both versions. (`issue-2-cross-repo-reorganization:b5`, amended)
  - provenance: caused by `c42` — plan `issue-2-cross-repo-reorganization`, frame `issue-2-cross-repo-reorganization`
  - proof: best strength `execution`
    - evidence: automated — execution: pass (run 2026-11-25 @ 92937aa)
  - lineage: `issue-2-cross-repo-reorganization:b3`, `issue-2-cross-repo-reorganization:b5`

## Ledger status

- proposed deltas awaiting adjudication: 1
- rejected deltas (excluded from this projection): 0
- retired lineages (superseded with no live replacement): 0
