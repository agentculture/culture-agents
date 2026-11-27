# D0 decision records

One record for each of the six decisions in the "Decisions to resolve in D0"
list of issue [#2](https://github.com/agentculture/culture-agents/issues/2),
plus the records that D1 added. Each is **decided** or **open**.

Dates: the spec frame was created on 2026-11-24 and last updated on
2026-11-24T23:05Z, and the decisions below were confirmed within it. The frame
stores no per-claim date, so "2026-11-24" is the frame's date, except where a
claim carries its own (marked). Claim ids are from
[`../specs/2026-11-24-issue-2-cross-repo-reorganization.md`](../specs/2026-11-24-issue-2-cross-repo-reorganization.md).
The issue comment of 2026-11-24T23:00Z, "Decisions taken so far (D0)", repeats
them.

## Summary

| # | Decision | Status | Claims |
| --- | --- | --- | --- |
| 1 | SDK adapter versus AgentCulture feature | **open** (D1 slice decided) | `c56`, `c57`, `c58` |
| 2 | TypeScript and Python seam | **decided** 2026-11-24 | `c31`, `c36`, `c37`, `c55` |
| 3 | Run and session ownership, authorization | **open** (D1 default decided) | `c45` |
| 4 | AgentIRC behaviors kept or sunset | **open** | none |
| 5 | Embodiment history versus executable sessions | **open** | none |
| 6 | Resource signals | **decided** 2026-11-24 | `c29` |
| D1 | OpenCode path for D1 | **settled** (corrected in D2) | `c61`, `c63`; `core/src/harness/opencode/client.ts`; `docs/d0/d1-acceptance.md` |

## Decision 1: SDK adapter versus AgentCulture feature

**Status: open.** Part of it is decided for D1.

Decided (2026-11-24): D1 runs each harness through the AI SDK adapters inside
an OpenShell sandbox, with culture-agents writing the sandbox provider
(`c57`, `c56`). If steer or the bridge fails for a harness, it falls back to
its vendor SDK behind the same adapter interface and the capability document
says so (`c58`). Note `c57` and `c58` are requirements with an `llm` origin,
confirmed; `c56` is a user decision.

Evidence from the probe (measured once, 2026-11-24 and 2026-11-25):

- Claude Code through the adapter: prompt, stream, steer and cancel pass.
- OpenCode 1.19.5 through the adapter: the same four pass.
- OpenCode 2.3.2 through the adapter: fails to start. The adapter targets the
  1.x server API.
- A provider-created sandbox leaks when `doStart` fails; culture-agents has to
  own that cleanup.

Still open: which capabilities stay in culture-agents rather than the adapter
for D2 and later. The adapter API is experimental. Not verified: `doStop`,
`doDetach`, resume across processes, approvals other than `allow-all`, host
tools.

To close it: a short table naming each capability (dispatch, placement,
idempotency, sessions, steer, cancel, answer, resume) as adapter or ours, with
a probe result for each adapter row, and a pin policy for the adapter
versions.

## Decision 2: TypeScript and Python seam

**Status: decided, 2026-11-24.**

| Part | Decision | Claim |
| --- | --- | --- |
| Core language | TypeScript. The Python `agents` CLI is its controller, used as an API client | `c31` |
| Packaging | Two packages, each versioned and released on its own. The core runs as a supervised local daemon on Node >= 22 with a versioned JSON API and an SSE event stream over a Unix socket | `c36` |
| Version check | The CLI checks the core's API version on connect and refuses an incompatible one with exit 2 | `c36` |
| Schemas | The JSON schemas in this repo are the source of truth for both | `c36` |
| Python dependency | agentfront is approved as a runtime dependency, amending the zero-dependency rule in `CLAUDE.md` | `c37` |
| npm name | `@culture.dev/agents`, published following embeddings-tumbler's workflow, with PyPI waiting for npm | `c55` |

History: `c36` first proposed one wheel with the core bundled. The user chose
two packages on 2026-11-24 (revision recorded on the claim).

Left open inside it (spec parks, non-blocking): how the daemon is supervised
(systemd user unit or started by the CLI), and where daemon logs go.

## Decision 3: run and session ownership, authorization

**Status: open.** A D1 default exists; the model across callers does not.

Decided as a D1 requirement: dispatch authority defaults to deny, enforced by
the core, with an owner-only (0600) control socket and a local allow-list that
ships empty (`c45`; an `llm`-origin requirement, confirmed).

Not decided: ownership and authorization across human, Gwen, chat and workflow
callers; the auth scope carried on a run; who may attach, steer or answer a run
someone else submitted. The spec's D0 requirement (`c6`) lists the auth model
as a D0 output; it is not yet written.

To close it: an auth-model document and schema fields (principal, scope,
idempotency key) reviewed by the culture-rules and embodiment owners, whose
trackers are
[culture-rules#154](https://github.com/agentculture/culture-rules/issues/154)
and [embodiment#130](https://github.com/agentculture/embodiment/issues/130).

## Decision 4: AgentIRC behaviors kept or sunset

**Status: open.**

What exists: the feature inventory of agentirc in [`inventory.md`](inventory.md)
and the mesh-continuity gates in the receiving issues, chiefly
[culture-chat#3](https://github.com/agentculture/culture-chat/issues/3) and
[agentirc#70](https://github.com/agentculture/agentirc/issues/70).

Nothing says which behaviors are kept or sunset. This is D3 work, outside the
D1 target (`c32`).

To close it: a per-behavior keep or sunset list (identity namespace, per-peer
anti-spoofing, replay, federation, presence) with each raw IRC client's wire
behavior from the [matrix](compatibility-matrix.md), agreed by the culture-chat
and agentirc owners.

## Decision 5: Embodiment history versus executable sessions

**Status: open.** The issue's recommendation is "yes": Embodiment keeps its
conversational history and culture-agents owns only executable agent sessions,
with IDs and correlation defined explicitly. No spec claim confirms it.

To close it: the embodiment owner accepts the split in
[embodiment#130](https://github.com/agentculture/embodiment/issues/130), and
the correlation ID fields are named in the run schema.

## Decision 6: resource signals

**Status: decided, 2026-11-24.**

Placement and admission read heat-governor's published state (`state.json`,
`heat-governor wait`) and the local model gateway's status endpoint as they
are. A missing or stale signal reads as unknown. Neither repo changes
(`c29`; an `llm`-origin assumption, confirmed, and repeated as "Decision 6" in
the issue comment of 2026-11-24).

Evidence added since: a sandbox reached the local model gateway as
`host.openshell.internal:8001` through a custom inference profile (OpenCode v2
returned `pong`, once). That closes the spec's park on gateway reachability.
Not verified: reading heat-governor from a sandbox, and the placement logic
itself, which is D2.

## D1 records beyond the six

| Record | Status | Source |
| --- | --- | --- |
| Target is D1: single host, dispatch, inspect, steer, cancel, no chat | decided 2026-11-24 | `c32` |
| Sibling repos may change via branches and PRs for this work | decided 2026-11-24 | `c33` |
| culture-nodes out of scope; embodiment's opencode-subagent plan paused | decided 2026-11-24 | `c34` |
| Workspace map lives in culture; codexd may be moved | decided 2026-11-24 | `c35` |
| After a daemon restart, workers keep running; live control returns in D2 | decided 2026-11-24 | `c54` |
| OpenShell is the sandbox, not a home-written provider | decided 2026-11-24 | `c56` |
| OpenShell may be installed at user level on this host | decided 2026-11-24 | `c59` |
| Runs use `runs/<id>` branches; the repo enters the sandbox as a git bundle and the host fetches over SSH | decided 2026-11-24 | spec Decisions section; probe options A and B passed once each |
| Second D1 harness is OpenCode v2, not Codex; Codex is not verified | decided 2026-11-25 | `c61`; plan deviation `d1` |

The working-tree handoff was a blocking park resolved "let the probe decide"
(2026-11-24). Probe options A and B both passed; option C (mounting a host
worktree) was not tested because it needs a gateway setting that is off.

## D1 OpenCode path (settled)

**Status: settled; corrected in D2 part one.** This section used to read "open". The D1
frame (`c63`) and the live D1 acceptance settled it: the core drives OpenCode v2 (2.3.2)
through its own server API (`opencode serve`; `core/src/harness/opencode/client.ts`), a
third path that was not in the table below, and the live run recorded steer and cancel
for it (`docs/d0/d1-acceptance.md`). The text from here to the end of this section is
kept as it was written, as the history of the choice; read it as history, not as an open
question.

`c61` fixes the harness (OpenCode v2) but not how culture-agents drives it. Two
paths were measured; the probe covers both only partly.

| Property | Option A: AI SDK adapter, OpenCode 1.19.5 | Option B: `opencode acp`, OpenCode 2.3.2 |
| --- | --- | --- |
| Version run | 1.19.5 (the adapter's pin) | 2.3.2 (the v2 the owner named) |
| Prompt and stream | pass once | pass once |
| Mid-run steer | pass once | not verified; ACP has no in-turn user message |
| Turn cancel | pass once | pass once |
| Cancel ends the tool's child process | pass once | **fail**: process survives until the sandbox is deleted |
| Needs from us | a profile naming the adapter's binary path, or copying the binary (workaround used) | an ACP driver in the culture-agents core; a reaper for the child process |
| Same interface as Claude Code | yes, through `HarnessAgent` | no, a second driver |
| Risk | it is not OpenCode v2, and the adapter does not support v2 yet | no steer, so D1's steer acceptance would not be met for this harness |

Both paths are single measurements on one host.

To close it, the owner chooses one of:

1. Option A, accepting that D1 runs OpenCode 1.19.5, not v2.
2. Option B, accepting no steer for OpenCode in D1 and writing the child
   reaper.
3. Wait for an AI SDK adapter release built on the v2 server API, then
   re-run the four checks. No such release has been checked.

The choice also decides whether the spec's D1 requirement that steer works
through real harnesses can be met by two harnesses or by one.
