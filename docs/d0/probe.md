# D1 probe: AI SDK harness adapters in an OpenShell sandbox

Plan task t1. Run on 2026-11-24 on the fleet host (x86_64, Docker 28.0.1).
Status: **partial**. The credential-free half is done; the live harness half
has not run yet.

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
| Claude Code: submit, stream, steer, cancel | not verified | needs an Anthropic API key in an OpenShell provider |
| Codex: submit, stream, steer, cancel | not verified | needs Codex OAuth tokens in an OpenShell provider |
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

## Open items

- Live harness runs, once credentials are decided.
- The sandbox image needs the harness CLIs; the stock base image
  (`nvcr.io/nvidia/base/ubuntu:24.04`) has neither git nor Node.
- OpenShell's bundled `claude-code` profile takes an Anthropic API key; its
  `codex` profile takes Codex OAuth tokens, not an OpenAI API key.
