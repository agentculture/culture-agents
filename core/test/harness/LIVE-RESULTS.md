# Live harness results (plan task t11)

Run on 2026-11-25 on the fleet host (x86_64) against the running OpenShell
gateway (`https://127.0.0.1:17670`). Each run created its own sandbox with the
prefix `t11-` and deleted it. `openshell sandbox list` showed no sandboxes
afterwards. Host repositories were temporary repos under the system temp dir.

## Versions

| Component | Version |
| --- | --- |
| OpenShell CLI and gateway | 0.1.10 |
| Node.js (host) | 24.13.1 |
| Node.js (run image) | 22.23.5 |
| `ai` | 7.0.181 (through `@ai-sdk/harness`) |
| `@ai-sdk/harness` | 1.0.192 |
| `@ai-sdk/harness-claude-code` | 1.0.196 |
| Claude Code (bundled with the adapter's bridge) | 2.1.319 |
| OpenCode | 2.3.2 |
| Run image | `culture-agents-run:dev`, `sha256:225b9497eb60…` |
| Providers attached | `claude-sub` (Claude Code), `lobes` (OpenCode) |
| Models | Claude Code `haiku`, OpenCode `gateway/worker` |

## Command

```bash
source <scratch>/osh/env.sh        # openshell CLI on PATH, OPENSHELL_LOCAL_TLS_DIR
cd core && npm run build
CULTURE_AGENTS_LIVE_HARNESS=1 CULTURE_AGENTS_LIVE_TRIALS=2 \
CULTURE_AGENTS_SANDBOX_PREFIX=t11- CULTURE_AGENTS_LIVE_TAP_DIR=<scratch>/tap \
CULTURE_AGENTS_LIVE_HARNESSES=claude-code node --test dist/test/harness/live.test.js
# and the same with CULTURE_AGENTS_LIVE_HARNESSES=opencode, run in parallel
```

Without `CULTURE_AGENTS_LIVE_HARNESS=1`, or when the gateway, the image or a
provider is missing, every live check is skipped and reported as
`NOT VERIFIED: ...`. A skipped check never counts as a pass.

## Results

Both files: `tests 7, pass 7, fail 0, skipped 0`. That is six live checks per
harness (three checks, two trials each), plus the refusal check, which needs
no model.

| Harness | Capability | Declared | Live result | Trials | Observed |
| --- | --- | --- | --- | --- | --- |
| claude-code | submit (complete, commit on `runs/<id>`) | yes | pass | 2 | `completed`, summary `done`; files `README hello.txt` on `runs/<id>`; host still on `main`, status unchanged |
| claude-code | stream | yes | pass | 2 (same runs as submit) | 4 output events before the outcome (tool call, tool result, text, diagnostic) |
| claude-code | steer | yes | pass | 2 | steered after 2 of 10 writes; files `README STEERED.txt file01.txt file02.txt file03.txt` both times |
| claude-code | cancel | yes | pass | 2 | `stopped`; new processes 4 then 3 after the interrupt, 0 after the bridge closed, 0 killed, 0 remaining; sandbox deleted (`openshell sandbox get` fails) |
| opencode | submit (complete, commit on `runs/<id>`) | yes | pass | 2 | `completed`, summary `done`; files `README hello.txt`; host unchanged |
| opencode | stream | yes | pass | 2 (same runs as submit) | 15 and 18 output events before the outcome |
| opencode | steer | yes | pass | 2 | steered after 2 of 6 commands; files `README STEERED.txt file1.txt file2.txt` both times |
| opencode | cancel | yes | pass | 2 | `stopped`; 4 new processes after the interrupt (`opencode serve`, the `opencode-pty` daemon, `bash -c sleep 120 ...`, `sleep 120`); after the server stopped, `sleep 120` was still running; the driver killed 1; 0 remaining; sandbox deleted |
| both | pause, resume, answer (undeclared) | no | refused | 2 per harness, mid-run | in each steer run, `control(pause\|resume\|answer)` threw `unsupported` naming the capability while the turn ran, and the run went on to complete |
| both | continue_session, delegate, placement, reconnect, worktree_isolation (undeclared) | no | refused | unit tests | `refusalFor` returns an `unsupported` error naming the capability. These are not driver actions; the core refuses them at submit or control time |

## Findings

- **OpenCode interrupt leaves tool processes.** OpenCode's interrupt ends the
  turn, but the tool's `sleep 120` survives both the interrupt and stopping the
  server. The driver finds it, because it compares a process baseline taken
  before the harness started, kills it, and then deletes the sandbox. This
  matches the probe's ACP finding.
- **Claude Code leftovers vary.** In both trials the Claude Code process exited
  together with the bridge. In an earlier ad-hoc cancel, with no settle delay
  before the process check, the native `claude` process outlived the closed
  bridge, and the driver killed it. The driver now waits 1.5 s before each
  process check.
- **Gateway profile versus repo profile.** The gateway's
  `claude-code-subscription` profile only allows binaries under
  `/usr/lib/node_modules/@anthropic-ai/**`, not the repo profile's
  `/usr/local/lib/ai-sdk-harness/**`. The image installs the bridge at the repo
  location and also keeps a real copy under the gateway's glob (build argument
  `CLAUDE_BRIDGE_COMPAT=1`, the default). The `lobes-gateway` profile also
  allows `/usr/bin/curl`; the image has no curl.
- **OpenCode writes a binary to the writable home.** OpenCode 2.3.2 extracts
  `opencode-pty` to `/sandbox/.cache/opencode/bin/` at run time and runs it
  from there. It needs no network access, but it is an executable in a path
  the run can write.
- **The OpenCode password does not have to be parsed.**
  `OPENCODE_SERVER_PASSWORD` sets the per-process password, so the driver
  generates one per run and passes it in the environment of `opencode serve`.
- **No harness files are left in the working tree.** Neither harness left
  config files in the clone: the collected commits held only the task's files.

## Live turns spent

18 harness turns: 6 ad-hoc probe runs while building (3 per harness: smoke,
steer, cancel) and 12 suite runs (3 checks × 2 trials × 2 harnesses). Each
steer counts as part of its run's turn.
