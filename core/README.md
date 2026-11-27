# @culture.dev/agents

The TypeScript core of [culture-agents](https://github.com/agentculture/culture-agents),
the agent control plane for AgentCulture: dispatch an agent, inspect, steer
and cancel its run, with no chat server involved.

This package is the daemon. The command-line client is the Python package
[`culture-agents`](https://pypi.org/project/culture-agents/) (`agents`), which
talks to the daemon over a Unix socket. The two are versioned together, and
the client checks the daemon's API version on connect.

## What it does

- Serves the control API (HTTP over a Unix socket; JSON, with a server-sent
  event stream for a run's events).
- Stores every run on disk and runs each one in its own detached worker
  process, so a run outlives a daemon restart and its state is read back
  truthfully.
- Runs harnesses inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
  sandbox: Claude Code and OpenCode v2, plus a stub for tests.
- Refuses every dispatch by default: a submit must match an entry in a local
  allow-list file that only the operator edits.

It is a single-host control plane. Fleet placement, recovery of live control
after a restart, pause, resume and operator questions are not built.

## Requirements

- Node.js 22 or newer, on Linux.
- An OpenShell gateway and a run image for real harnesses (`image/` holds the
  image definition, `policy/` the sandbox policy and provider profiles).

## Use

```bash
npm install -g @culture.dev/agents
culture-agents-core        # start the daemon
```

The daemon listens on `$CULTURE_AGENTS_SOCKET`, else
`$XDG_RUNTIME_DIR/culture-agents/core.sock`, else
`${XDG_STATE_HOME:-$HOME/.local/state}/culture-agents/core.sock`. The allow-list
is `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/allowlist.json` and ships
empty.

Run events can also go to the workspace's events broker (events-cli: Mosquitto
on loopback). Publishing is off unless `CULTURE_AGENTS_BROKER_URL` names a
loopback broker, for example `mqtt://127.0.0.1:1883`. Each event is published
after it is appended to the run's log, under a type `agents.run.<what>` and
with the id `<run id>:<cursor>`. A message holds the run id, the event kind,
the run's state, the cursor and the time, never the run's content. A broker
that is down never blocks or fails a run: the events stay in the log and are
published when the broker is back.

Then, with the Python client:

```bash
agents agents list
agents runs submit --agent <id> --harness claude-code --repo <path> --task "<work>"
agents runs attach <run-id>
```

The contract (JSON Schemas, routes, error table, state machine) is in the
repository's [`contract/`](https://github.com/agentculture/culture-agents/tree/main/contract)
directory and ships in this package under `dist/contract-schemas/`.

## Injected secrets

The core is started with credentials in its environment. It reads each one once at start, keeps it in
memory and deletes it from `process.env` before any worker, host command (`git`, `openshell`) or
sandbox exists, so none of them inherits it. That is all it does: the kernel keeps the core's initial
environment in `/proc/<pid>/environ`, which any process of the same user can read, so the secrets
stay readable there for the life of the core. The way to avoid that is to give the core its secrets
by file or descriptor instead of the environment (planned, not built). The list is declared in one place,
`INJECTED_SECRETS` in `src/daemon/secrets.ts`: `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `LOBES_GATEWAY_KEY` and `CULTURE_AGENTS_FLEET_KEY`.
The worker spawner, the host command runner and the sandbox environment filter also drop these names
from any environment they are given.

## Fleet transport (off by default)

A TLS 1.3 listener for other cores, authenticated in both directions by Ed25519 key against a local
trust list (`src/fleet/`). It opens only when `CULTURE_AGENTS_FLEET_LISTEN` is set to `<ip>:<port>`.
The key comes as `CULTURE_AGENTS_FLEET_KEY` (above), so it stays readable in the core's
`/proc/<pid>/environ` to the same user. `culture-agents-fleet keygen` makes a key, and
`culture-agents-fleet cert` prints the trust entry other members add. See
`docs/d2/fleet-transport.md`.

## License

Apache-2.0
