# Corrections to stale records (D2 part one)

The D2 frame's follow-up item lists records that went stale. What was done to each:

| Record | What was stale | What was done |
| --- | --- | --- |
| `docs/d0/decisions.md` (section "D1 OpenCode path", table row D1) and `docs/d0/compatibility-matrix.md` | Listed the OpenCode path as open | Marked settled: the core drives OpenCode v2 (2.3.2) through its own server API (`core/src/harness/opencode/client.ts`), and the live D1 acceptance ran it (`docs/d0/d1-acceptance.md`). The old comparison table is kept as history |
| The D1 frame's parked item on reaching the local model gateway from a sandbox (`docs/specs/2026-11-24-issue-2-cross-repo-reorganization.md`, unknown_nonblocking item) | Still parked | Settled by `docs/d0/probe.md` ("OpenCode against the local model gateway"): a sandbox reaches the gateway as `host.openshell.internal:8001` through a custom inference profile. `docs/d0/decisions.md` (Decision 6) already says it closes the park. The frame itself is a confirmed spec and is not edited; read this line as its correction |
| The published explainer | Predates both settlements | **Not corrected**: it is a page outside this repository (named in `.devague/handoff-issue-2.md`) and cannot be edited from a checkout. The owner needs to republish it |
| The local `cultureagent` checkout | 2 commits behind upstream (0.15.2 against 0.17.0) | Not changed, since it is a sibling. A citation taken from it must be re-checked against upstream main before it is relied on |
