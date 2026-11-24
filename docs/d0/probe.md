# D1 probe: AI SDK harness adapters in an OpenShell sandbox

Plan task t1. Run on 2026-11-24 and 2026-11-25 on the fleet host (x86_64,
Docker 28.0.1).
Status: **done, with one harness blocked on the AI SDK path**. The AI SDK
`HarnessAgent` drives Claude Code inside an OpenShell sandbox through a small
custom sandbox provider: prompt, streamed events, mid-run steer and cancel all
pass live. The OpenCode adapter cannot drive OpenCode v2 (2.3.2): it is built
against the OpenCode 1.x server API. The same adapter passes all four checks
with the OpenCode 1.19.5 binary it pins. OpenCode v2 itself passes a prompt and
a turn cancel over its own ACP protocol in the sandbox. Codex is out of scope.

## Versions

| Component | Version |
| --- | --- |
| OpenShell CLI and gateway | 0.1.10 (release tarballs, sha256 verified) |
| Node.js (host) | 24.13.1 |
| Node.js (sandbox image) | 22.23.5 |
| `ai` | 7.0.181 |
| `@ai-sdk/harness` | 1.0.192 |
| `@ai-sdk/harness-claude-code` | 1.0.196 |
| `@ai-sdk/harness-codex` | 1.0.194 |
| `@ai-sdk/harness-opencode` | 1.0.195 |
| `@ai-sdk/provider-utils` | 5.0.83 |
| `@ai-openshell/sdk` | 0.1.10 |
| `ai-sdk-sandbox-local` (read as a reference only) | 0.1.2 |
| Claude Code (image) | 2.1.323 |
| Claude Code bridge deps (pinned by the adapter) | `@anthropic-ai/claude-agent-sdk` 0.3.319, `@anthropic-ai/claude-code` 2.1.319 |
| OpenCode bridge deps (pinned by the adapter) | `@opencode-ai/sdk` 1.19.5, `opencode-ai` 1.19.5 |
| OpenCode (image) | 2.3.2 (`culture-agents-probe:0.3`), 1.19.5 (`:0.5`) |
| pnpm (image build only) | 10.33.0 |
| Codex CLI (image) | 0.171.0 |

## Install route

The official installer installs a `.deb` and needs root; this host has no
passwordless sudo. The probe used the release tarballs `openshell` and
`openshell-gateway` unpacked into a scratch directory, with the gateway started
the way the packaged systemd user unit does it:

```bash
openshell-gateway generate-certs --output-dir "$OPENSHELL_LOCAL_TLS_DIR" \
  --server-san host.openshell.internal
OPENSHELL_LOCAL_TLS_DIR=... openshell-gateway        # binds 127.0.0.1:17670
openshell gateway add https://127.0.0.1:17670 --local --name openshell
```

The gateway selected the Docker compute driver and `openshell status` reported
`Connected`, authenticated over mTLS. A gateway started without local TLS
material or another auth method refuses to start.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Create a sandbox | pass | `sandbox create --from culture-agents-probe:0.1` reached `Ready` in 0.6 s (image cached) |
| Operator credentials absent | pass | no `GH_TOKEN`, `GITHUB_TOKEN` or `SSH_AUTH_SOCK` in the sandbox environment |
| Network default | pass | `github.com` and `api.anthropic.com` unreachable; log shows `NET:OPEN DENIED ... transparent_tcp_policy_denied` |
| Push to the remote denied | pass | `git push https://github.com/...` fails: `Couldn't connect to server` |
| AI SDK steer support (static) | pass | `HarnessV1PromptControl.submitUserMessage` exists and both adapters reference it |
| AI SDK suspend and continue (static) | pass | `doSuspendTurn` and `doContinueTurn` are required on every adapter |
| Claude Code one-shot prompt, API key | pass | `claude -p` in a sandbox returned `pong`; 4.2 s including sandbox create and delete |
| Claude Code one-shot prompt, subscription | pass | same prompt with a bearer-token profile returned `pong` in 3.5 s |
| Claude Code one-shot prompt, durable subscription token | pass | token from `claude setup-token` stored in `grant` and injected at provider creation; `pong` in 3.2 s |
| OpenCode v2 one-shot prompt, local model gateway | pass | `opencode run -m gateway/worker` returned `pong` in 7.2 s; the gateway answered `200` from inside the sandbox |
| Codex one-shot prompt | fail | authenticates, then `selected workspace missing from routing discovery`; `*.oaiusercontent.com` is denied by the stock profile |
| Codex: stream, steer, cancel through the AI SDK | not verified | out of scope by owner decision |
| OpenShell sandbox provider self-test (no harness) | pass | `node selftest.mjs`: exec, file read/write/stat/list/delete, spawn with stdin, `forward` to a port in the sandbox returned `pong`, `kill` ended the remote process, sandbox deleted |
| AI SDK + Claude Code: start session and prompt | pass | `node run-harness.mjs claude smoke`: sandbox ready in 0.8 s, session ready at 1.3 s, text `"pong"` at 4.2 s |
| AI SDK + Claude Code: streamed events | pass | same run: `start`, `start-step`, `text-start`, `text-delta`, `text-end`, `finish-step`, `finish`; the steer run streamed 84 parts incl. `tool-input-delta`, `reasoning-delta` |
| AI SDK + Claude Code: mid-run steer | pass | `node run-harness.mjs claude steer`: steer sent after 2 of 10 writes; files at the end `STEERED.txt file01.txt file02.txt file03.txt` |
| AI SDK + Claude Code: cancel | pass | `node run-harness.mjs claude cancel`: abort 3 s after `bash sleep 120`; stream ended with an `abort` part; 2 s later no `claude` or `sleep` process in the sandbox, only the bridge |
| AI SDK + Claude Code: destroy deletes the sandbox | pass | every run: `session.destroy()` then `get` on the sandbox fails: `deleted` |
| AI SDK + OpenCode v2 (2.3.2): start session and prompt | fail | `node run-harness.mjs opencode smoke` on `:0.3`: `Timeout waiting for server to start after 30000ms`; with a startup-line shim (`:0.4`): `Request is not supported by this version of OpenCode Server (Server responded with text/html)` |
| AI SDK + OpenCode v2: stream, steer, cancel | not verified | blocked by the row above |
| AI SDK + OpenCode 1.19.5 (adapter-pinned): start session and prompt | pass | `SPIKE_IMAGE=culture-agents-probe:0.5 node run-harness.mjs opencode smoke`: text `"pong"` at 9.9 s |
| AI SDK + OpenCode 1.19.5: streamed events | pass | same run: `reasoning-delta` x5, `text-delta` x2, `finish`; the steer run streamed `tool-call` / `tool-result` per write |
| AI SDK + OpenCode 1.19.5: mid-run steer | pass | `... opencode steer`: steer after 2 writes; files at the end `STEERED.txt file01.txt file02.txt file03.txt` |
| AI SDK + OpenCode 1.19.5: cancel | pass | `... opencode cancel`: abort 3 s after `bash sleep 120`; `abort` part; no `sleep` process left, `opencode serve` and the bridge stay up for the next turn |
| Adapter-pinned OpenCode binary under the `lobes` profile | fail | `opencode-ai/bin/opencode.exe run ...` in a sandbox: `DENIED .../node_modules/.pnpm/opencode-ai@1.19.5/.../opencode.exe -> host.openshell.internal:8001` |
| OpenCode v2 over ACP (`opencode acp`), prompt and stream | pass | `node acp-probe.mjs`: `initialize` reports OpenCode 2.3.2; `session/prompt` `stopReason=end_turn`, `session/update` chunks, text `"pong"` |
| OpenCode v2 over ACP: turn cancel | pass | `session/cancel` 3 s after the `tool_call`: `stopReason=cancelled` |
| OpenCode v2 over ACP: cancel stops the tool process | fail | after `cancelled`, `ps` still shows `sleep 120` under the `opencode-pty` daemon; only sandbox deletion ended it |
| OpenCode v2 over ACP: mid-run steer | not verified | ACP has no in-turn user message; not attempted |

## Working-tree handoff

The test repository had two commits on `main`. In every case the host
checkout stayed on `main` with a clean status.

| Option | Result | Notes |
| --- | --- | --- |
| A. Git bundle in, git bundle out | pass | `sandbox upload` a bundle, `git clone -b main` inside, commit on `runs/probe-1`, `sandbox download` a bundle of `main..runs/probe-1`, `git fetch` it on the host |
| B. Git bundle in, host fetches over SSH | pass | same way in; the host runs `git fetch ssh://openshell-<name>.default/sandbox/work` with the config from `sandbox ssh-config` |
| C. Mount a host worktree | not tested | needs `--driver-config-json`, which is disabled unless the gateway administrator enables `allow_driver_config` |

A bundle created from a branch carries no `HEAD`, so the clone inside the
sandbox must name the branch (`git clone -b main`).

## What the AI SDK needs from a sandbox provider

`HarnessV1SandboxProvider` requires `createSession` and optionally
`resumeSession`. The session must run commands, read and write files, expose
ports (`getPortUrl`), and stop or destroy itself; network policy and request
transformations are optional. The OpenShell SDK offers `create`, `exec`,
`execStream`, `execInteractive`, `forward`, `createSshSession`, `waitReady`
and `delete`, so each required member has a counterpart.

## Credentials and profiles

- **Stock `claude-code` profile does not match an npm install.** It allows
  `/usr/bin/claude` and `/usr/local/bin/claude`, but the process that opens the
  connection is `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  so every call to `api.anthropic.com` was denied until a profile listing
  `/usr/lib/node_modules/@anthropic-ai/**` was imported under a new id. Updating
  the stock profile in place failed.
- **Subscription works with a custom profile.** A profile whose credential is
  `CLAUDE_CODE_OAUTH_TOKEN` with `auth_style: bearer` on the `authorization`
  header lets Claude Code run on a Claude subscription. The probe used the
  short-lived token from the local login; a durable setup uses the token from
  `claude setup-token`.
- **The sandbox never holds the secret.** Inside the sandbox each credential
  variable holds an `openshell:resolve:env:` placeholder that the proxy resolves
  at egress.
- **Codex needs a launcher.** Codex reads `~/.codex/auth.json`, not environment
  variables, and parses its tokens as JWTs. The probe wrote that file inside
  the sandbox from the placeholders, wrapping each in the documented JWT-shaped
  alias with the real tokens' non-secret claims. Authentication then passed
  (no more `401`), but the turn failed as recorded above.

## OpenCode against the local model gateway

- The second D1 harness is OpenCode v2 (2.3.2), replacing Codex by the owner's
  decision on 2026-11-25. Codex stays not verified.
- On this host OpenCode uses the local model gateway on port 8001. A sandbox
  reaches it as `host.openshell.internal:8001` through a custom inference
  profile that names that host and port, lists `/usr/local/bin/opencode` as an
  allowed binary and carries the gateway key as a bearer credential.
- The probe image copies the host's OpenCode binary and a config whose
  `baseURL` is `http://host.openshell.internal:8001/v1` and whose key is read
  from the placeholder variable.
- This also settles the earlier open question: a sandboxed harness can reach
  the local model gateway under OpenShell network policy.

## AI SDK through OpenShell

Spike code is in `spikes/d1-probe/` (throwaway; exact versions in its
`package.json`, raw transcripts in `spikes/d1-probe/evidence/`). Every live run
created its own sandbox named `spike-` plus a hash and deleted it at the end.

### The sandbox provider

`openshell-sandbox.mjs` (about 290 lines) implements
`HarnessV1SandboxProvider` (`createSession`, `resumeSession`) and
`HarnessV1NetworkSandboxSession` on the OpenShell TypeScript SDK alone; no
`openshell` CLI calls were needed.

| Member | OpenShell primitive |
| --- | --- |
| `createSession` | `SandboxClient.create({ name, image, providers })` then `waitReady`; the name is `spike-` plus a hash of the session id, because OpenShell caps names at 19 characters |
| `run`, file reads, `stat`, `listDirectory`, `deleteFile` | `exec(name, ['sh', '-c', ...], { noLoginShell: true })`; a missing file maps to a sentinel exit code and `null` |
| `writeBinaryFile` / `writeTextFile` / `writeFile` | `exec` of `mkdir -p` and `cat >` with the bytes on `stdin` |
| `spawn` (with or without stdin) | `execInteractive(..., { tty: false })`; output events split into stdout and stderr `ReadableStream`s, `write` and `closeInput` back the stdin `WritableStream`, `cancel()` is `kill()` and ends the remote process |
| `getPortEndpoint` / `getPortUrl` | `forward(name, { targetPort })` binds an ephemeral `127.0.0.1` port on the host; returns `ws://127.0.0.1:<local port>` |
| `stop` / `destroy` | kill tracked processes, close forwards; `destroy` adds `delete` and `waitDeleted` |
| `restricted()` | the same class without the lifecycle members |

Not implemented: `setNetworkPolicy`, `setRequestTransformations`,
`addRequestTransformations` (OpenShell policy and provider profiles already do
this outside the sandbox), snapshot reuse by `identity`, and a real
`resumeSession` test. `HarnessAgent` logs that the `sandbox` provider setting
is deprecated in favour of passing a `sandboxSession` to `createSession()`;
the same session object serves both paths, but then the caller owns deletion.

### How the bridge reaches the host

Both adapters run a Node bridge in the sandbox
(`$HOME/.ai-sdk-harness/.harness-bootstrap/<harness>/bridge.mjs`) that listens
on the first port in `session.ports` (4100 here) on `0.0.0.0`. The adapter asks
`getPortEndpoint` for a `ws` URL and opens a WebSocket, authenticated by an
Ed25519 key pair it generates per session. OpenShell's `forward` tunnels the
host port to `127.0.0.1:4100` in the sandbox over the gateway's mTLS channel,
so no port is exposed to the network and no `--expose` is needed. Bootstrap,
bridge startup and the WebSocket handshake took about 0.4 s after the sandbox
was ready (0.6 s for OpenCode).

### What the image must contain

The adapters' bootstrap writes the bridge files and runs
`pnpm install --frozen-lockfile --store-dir .pnpm-store` in the sandbox. The
sandbox has no npm registry access and no `pnpm`, so the image
(`spikes/d1-probe/image/Dockerfile`, `culture-agents-probe:0.3`) does this at
build time from the adapters' own lockfiles:

- Claude Code bridge dependencies in
  `/usr/lib/node_modules/@anthropic-ai/ai-sdk-harness-bridge/`. The Agent SDK
  launches its bundled native `claude` from its own `node_modules`, and the
  `claude-sub` profile only lets binaries under
  `/usr/lib/node_modules/@anthropic-ai/**` reach `api.anthropic.com`. The
  directory name was chosen to fit that glob; the adapter exposes no
  `pathToClaudeCodeExecutable` setting.
- OpenCode bridge dependencies in `/usr/local/lib/ai-sdk-harness/opencode/`.
  `/opt` failed: the sandbox filesystem policy makes only `/usr`, `/lib`,
  `/etc` and `/bin` readable, and the bridge exited with
  `ERR_MODULE_NOT_FOUND`.
- A `pnpm` shim at `/usr/local/bin/pnpm` that links the baked `node_modules`
  into the bootstrap directory instead of installing. The rest of the
  bootstrap (file writes, `claude --version`, the marker) runs unchanged.
- For OpenCode, `opencode` on the bridge's `PATH` must be the binary at
  `/usr/local/bin/opencode`, the only path the `lobes` profile allows. The
  adapter's own `opencode-ai` binary under `node_modules` is denied (see
  Results).

The Docker image must not set `USER root`: OpenShell refused it with
`workload identity must not contain UID or GID zero`; an image with no `USER`
runs as `ubuntu` (uid 1000) with `HOME=/sandbox`.

### Credentials

Both adapters ran with `auth: {}`, so the host forwarded no credential. The
bridge inherits the sandbox environment, where OpenShell puts a placeholder
for `CLAUDE_CODE_OAUTH_TOKEN` (and `LOBES_GATEWAY_KEY`) that its proxy resolves
at egress. The OpenCode adapter got its gateway model through `openCodeConfig`
whose provider key is the reference `{env:LOBES_GATEWAY_KEY}`. Read from the adapter source, not
tested: without an explicit `auth`, the Claude Code adapter looks for
credentials on the host (environment, API-key
helper, macOS keychain or local subscription login) and forwards them into the
sandbox, which would defeat the placeholder model.

### Obstacles, in order

1. `USER root` in the spike Dockerfile: sandbox entered the error phase
   (identity with UID 0). Fixed by not setting `USER`.
2. Sandbox name length: `name exceeds maximum length (27 > 19)`. Fixed by
   hashing the session id.
3. OpenCode bridge dependencies under `/opt`: not readable in the sandbox.
   Moved under `/usr/local/lib`.
4. OpenCode v2 server startup: the bridge's `@opencode-ai/sdk` 1.19.5 waits
   for a line starting `opencode server listening`; v2.3.2 prints
   `server listening on http://...`. Timeout after 30 s.
5. OpenCode v2 server API: with a shim that rewrites the startup line
   (`culture-agents-probe:0.4`), the bridge's first API call (`mcp.status`)
   got `text/html` back: the 1.x endpoints the adapter uses do not exist in
   v2. No adapter setting selects a different OpenCode client.
6. Adapter-pinned OpenCode binary under the `lobes` profile: denied at
   `host.openshell.internal:8001`. Worked around in `culture-agents-probe:0.5`
   by copying the 1.19.5 binary to `/usr/local/bin/opencode`; a real fix is a
   profile that names the bridge's binary path, which this probe did not
   create.
7. `HarnessAgent.createSession` does not destroy a provider-created sandbox
   when the adapter's `doStart` fails; one sandbox leaked and was deleted by
   hand. The spike driver now destroys it itself.

Claude Code's own behaviour showed up in the cancel run: it refused a
foreground `sleep 120` with a tool error and retried it in the background;
cancel stopped both.

Live harness turns spent: 11 model turns (Claude Code 4 prompts and 1 steer,
OpenCode 1.19.5 3 prompts and 1 steer, OpenCode v2 over ACP 2 prompts), plus
one call that the network policy denied before it reached the model.

## OpenCode v2 through its own server API

Run on 2026-11-25 on the host (not yet inside a sandbox), OpenCode 2.3.2,
model `gateway/worker`, at the owner's suggestion. `opencode serve` starts the
v2 API on a local port and prints a per-process password; requests use HTTP
basic auth with user `opencode`. The server publishes its API description at
`/openapi.json` (142 paths).

| Check | Result | Evidence |
| --- | --- | --- |
| Create a session and send a prompt | pass | `POST /api/session` with a `location.directory` and a model reference, then `POST /api/session/{id}/prompt` returned `200` |
| Streamed events | pass | `GET /api/event` delivered 150 events in the steer run (`session.reasoning.delta`, `session.text.delta`, `session.step.*`, `session.tool.*`) |
| Mid-run steer | pass | task: eight `sleep 4 && echo N > fileN.txt` commands one at a time; after two files a second prompt with `"delivery": "steer"` asked for `STEERED.txt` instead; result `STEERED.txt file1.txt file2.txt file3.txt` |
| Interrupt | pass | same task; `POST /api/session/{id}/interrupt` after two files returned `{"interrupted": true}`; the file list stayed at two |
| Child processes after interrupt | not verified | the check used was not able to tell a leftover `sleep` from the checking shell |
| Inside an OpenShell sandbox | not verified | not run yet; needs the server port forwarded and the gateway profile to allow the server binary |

Each check was run once. The prompt API takes `delivery: "steer"` or
`"queue"`, so steering is native here, unlike ACP. The API also exposes an
inbox of queued inputs, permission requests, forms for questions, and a wait
call, which map onto capabilities deferred beyond D1. The event stream is
documented as volatile (events during a disconnect are missed), so the run
store must not rely on it alone for the terminal state.

## Open items

- Codex is not pursued for D1. To revisit: allow the extra hosts it contacts
  and resolve the workspace routing error.
- OpenCode v2 through the AI SDK needs an adapter release built on the v2
  server API, or culture-agents drives `opencode acp` itself. Over ACP, cancel
  ends the turn but not the tool's child process.
- Not verified: `doStop`, `doDetach` and resume across processes (the
  provider's `resumeSession` only rebinds by name), snapshot reuse by bootstrap
  identity, approvals with `permissionMode` other than `allow-all`, host tools,
  and whether Claude Code's calls to `statsig.anthropic.com` or `sentry.io`
  were denied (the sandbox logs were not read before deletion).
- The sandbox image needs the harness CLIs; the stock base image
  (`nvcr.io/nvidia/base/ubuntu:24.04`) has neither git nor Node.
- OpenShell's bundled `claude-code` profile takes an Anthropic API key; its
  `codex` profile takes Codex OAuth tokens, not an OpenAI API key.
