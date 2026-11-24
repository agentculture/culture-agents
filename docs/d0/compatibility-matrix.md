# D0 compatibility matrix

One row per harness that issue
[#2](https://github.com/agentculture/culture-agents/issues/2) names, plus the
raw IRC clients D3 must cover. Spec claims `c6` and `c11` require it.

Sources: [`probe.md`](probe.md) (live, 2026-11-24 and 2026-11-25),
[`inventory.md`](inventory.md) (code read at pinned commits), and
[`../harness-verification.md`](../harness-verification.md) (prompt-file
resolution only).

How to read the cells:

- **pass** and **fail** are results measured in `probe.md`. Unless a cell says
  "repeated", each was **measured once**, in one run on one host.
- **not verified** means nobody ran it. It is never a pass.
- **planned** means the transport appears in the plan or inventory but no probe
  exercised it.
- A harness that cannot steer says so. Nothing here is inferred from another
  row.

## Harness rows

| Harness | D1 status | Interactive transport proved by the probe | Owner of the path |
| --- | --- | --- | --- |
| Claude Code | D1 harness 1 | AI SDK `@ai-sdk/harness-claude-code` bridge in the sandbox, WebSocket from the host through OpenShell `forward` | culture-agents (sandbox provider, D1 core); adapter by Vercel AI SDK; legacy path cultureagent |
| OpenCode, option A | D1 harness 2, **open** | AI SDK `@ai-sdk/harness-opencode` bridge, OpenCode **1.19.5** only | culture-agents; adapter by Vercel AI SDK |
| OpenCode, option B | D1 harness 2, **open** | `opencode acp` (ACP over stdio), OpenCode **2.3.2** | culture-agents would drive ACP itself |
| Codex | not verified | none: no turn completed | cultureagent (bridge, daemon), codexd |
| Pi via associate | not in D1 | none probed | associate |
| colleague | not in D1 | none probed | colleague |
| qwen (Qwen Code) | not in D1 | none probed | cultureagent (qwen bridge, ACP) |

D1 harness 2 is one decision with two candidate paths; see
[`decisions.md`](decisions.md#d1-opencode-path-open). Do not read the two
OpenCode rows as a ranking.

## Capability cells

Rows are probe results from `probe.md`. Every cell is "once" unless marked.

| Capability | Claude Code (AI SDK) | OpenCode 1.19.5 (AI SDK, option A) | OpenCode 2.3.2 (ACP, option B) | Codex |
| --- | --- | --- | --- | --- |
| One-shot prompt in a sandbox | pass: API key, subscription and durable token each once | pass once, `pong` at 9.9 s through the AI SDK; the binary had to be copied to `/usr/local/bin/opencode` (see Caveats) | pass once, `opencode run` returned `pong` in 7.2 s; ACP `end_turn` once | fail: authenticates, then `selected workspace missing from routing discovery` |
| Streamed events | pass: 84 parts on the steer run, text and reasoning deltas | pass: `reasoning-delta`, `text-delta`, `tool-call`, `tool-result` | pass: `session/update` chunks | not verified |
| Mid-run steer | pass: 2 of 10 writes, then `STEERED.txt` appeared | pass: same shape, `STEERED.txt` appeared | **not verified**: ACP has no in-turn user message; not attempted | not verified |
| Cancel stops the turn | pass: `abort` part, stream ended | pass: `abort` part | pass: `stopReason=cancelled` | not verified |
| Cancel stops the tool's child process | pass: no `claude` or `sleep` left; only the bridge | pass: no `sleep` left; `opencode serve` and the bridge stay up | **fail**: `sleep 120` survives under the `opencode-pty` daemon until the sandbox is deleted | not verified |
| Session destroy deletes the sandbox | pass, every run | pass, same driver | not verified (probe script, not the provider) | not verified |
| Pause and resume | not verified | not verified | not verified | not verified |
| Answer an operator question | not verified | not verified | not verified | not verified |
| Resume across processes | not verified (`resumeSession` only rebinds by name) | not verified | not verified | not verified |
| Approvals other than `allow-all` | not verified | not verified | not verified | not verified |

Static facts, not live results: the AI SDK defines `submitUserMessage`,
`doSuspendTurn` and `doContinueTurn`, and both adapters reference them
(`probe.md`, "AI SDK steer support" and "suspend and continue" rows, `pass` as
static checks). Suspend and continue were **not exercised**.

### Caveats that change what "pass" means

- **OpenCode 1.19.5 passes only with a workaround.** The adapter pins the
  1.19.5 binary under `node_modules`, which the `lobes` profile denies at
  `host.openshell.internal:8001`. The probe image copied that binary to
  `/usr/local/bin/opencode`. A real fix is a profile naming the bridge path;
  that profile was not created.
- **OpenCode 2.3.2 fails through the AI SDK.** Start-up timed out after 30 s,
  and with a start-up-line shim the first call returned `text/html`: the
  adapter targets the 1.x server API. Stream, steer and cancel through the AI
  SDK on v2 are **not verified**.
- **Claude Code needed a custom profile.** The stock `claude-code` profile
  does not match an npm install. The probe imported a profile under a new id.
- **Claude Code's own bridge location was chosen to fit a policy glob**
  (`/usr/lib/node_modules/@anthropic-ai/**`), because the adapter has no
  `pathToClaudeCodeExecutable` setting.
- **AI SDK leak on failed start:** `HarnessAgent.createSession` did not destroy
  a provider-created sandbox when the adapter's `doStart` failed; one sandbox
  leaked.
- **Credentials:** the sandbox held only `openshell:resolve:env:` placeholders.
  Not tested: without an explicit `auth`, the Claude Code adapter would look
  for host credentials and forward them. Read from source only.

## Harnesses outside D1

None of these was run in the probe. Their "transport" below is what the code or
plan says, not what was measured.

| Harness | Transport per source | Measured | Evidence |
| --- | --- | --- | --- |
| Pi via associate | associate wraps Pi 1.5.2 with a `ready.json` preflight (spec lead `s10`, issue #2 comment 3) | prompt-file resolution only (`.pi/SYSTEM.md`, `AGENTS.override.md`, 19 skills) | `harness-verification.md`; associate not cloned for the inventory, so **not verified** |
| colleague | resident process built on `agent-lifecycle` (batch library-embed contract); interactive transport not read, so **not verified** | prompt-file resolution only; loads **0 of 19** skills (colleague#494) | `harness-verification.md`; `colleague:pyproject.toml:92,105` in `inventory.md` |
| qwen | ACP over stdio (`cultureagent:cultureagent/bridges/qwen/acp/driver.py:1`) | prompt-file resolution only (`QWEN.md`) | `harness-verification.md`; `inventory.md` |
| Codex (existing paths) | `codex exec --json` one-shot bridge (`cultureagent:cultureagent/bridges/codex/codex_cli.py:1-14`); planned: app-server JSON-RPC | none for steer or cancel | `inventory.md`; plan claim on interactive transports |

The existing cultureagent bridges have no steer, answer, pause or resume route
(`inventory.md`, "Bridge HTTP API"). Any D2 disposition for these rows depends
on a probe that has not been run.

## Raw IRC clients for D3

Three hand-rolled raw-socket IRC clients, independent of `agentirc-cli`, must be
enumerated by wire behavior before the IRC wire format is retired (claim `c11`,
issue #2 comment 2 section 3 item 4). Only irc-lens was read for the inventory.

| Client | Where | Owner and D3 tracking | Wire behavior enumerated |
| --- | --- | --- | --- |
| irc-lens | `irc-lens:src/irc_lens/irc/transport.py:114` | irc-lens, [irc-lens#103](https://github.com/agentculture/irc-lens/issues/103) | not yet: location verified, behavior not listed |
| codexd | `harness/irc_transport.py` (spec lead `s10`) | codexd (repo owner; may be moved, claim `c35`); no tracking issue in the issue #2 table | not verified: repo not cloned |
| embodiment `mesh_client.py` | embodiment (spec lead `s10`) | embodiment, [embodiment#130](https://github.com/agentculture/embodiment/issues/130) is D5, not D3 | not verified: repo not cloned |

Also present, not one of the three: cultureagent has its own IRC transport with
SASL PLAIN (`cultureagent:cultureagent/clients/shared/irc_transport.py:76`),
archived at D6 (cultureagent#62).

## What this matrix does not say

- No disposition (keep, replace, archive) is given per installed path. The
  inventory records owners and receiving issues; dispositions need the D2 and
  D6 gates and the recovery tests in the spec.
- Nothing about the fleet: every probe ran on one x86_64 host with Docker
  28.0.1, OpenShell 0.1.10 and the pinned adapter versions in `probe.md`.
