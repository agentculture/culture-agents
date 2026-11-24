# D1 probe: AI SDK harness adapters in an OpenShell sandbox

Plan task t1. Run on 2026-11-24 on the fleet host (x86_64, Docker 28.0.1).
Status: **partial**. Claude Code runs live inside a sandbox on an API key and
on a subscription token, and OpenCode v2 runs against the local model gateway.
Codex authenticates but does not complete a turn.
The AI SDK `HarnessAgent` path through an OpenShell sandbox provider has not
run yet.

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
| `@ai-openshell/sdk` | 0.1.10 |
| Claude Code (image) | 2.1.323 |
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
| Claude Code and Codex: stream, steer, cancel through the AI SDK | not verified | needs the sandbox provider spike |
| HarnessAgent through an OpenShell sandbox provider | not verified | provider spike not written yet |

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

## Open items

- Codex is not pursued for D1. To revisit: allow the extra hosts it contacts
  and resolve the workspace routing error.
- The sandbox provider spike and live steer, stream and cancel through the AI
  SDK.
- The sandbox image needs the harness CLIs; the stock base image
  (`nvcr.io/nvidia/base/ubuntu:24.04`) has neither git nor Node.
- OpenShell's bundled `claude-code` profile takes an Anthropic API key; its
  `codex` profile takes Codex OAuth tokens, not an OpenAI API key.
