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

Then, with the Python client:

```bash
agents agents list
agents runs submit --agent <id> --harness claude-code --repo <path> --task "<work>"
agents runs attach <run-id>
```

The contract (JSON Schemas, routes, error table, state machine) is in the
repository's [`contract/`](https://github.com/agentculture/culture-agents/tree/main/contract)
directory and ships in this package under `dist/contract-schemas/`.

## License

Apache-2.0
