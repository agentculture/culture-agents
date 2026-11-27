# Observability: run traces in a local Langfuse

The core can export one trace per run to a Langfuse over OTLP. It is off unless an endpoint is set,
it never makes a request or a worker wait, and it carries no content unless you turn that on.

## Start Langfuse locally

This repository does not ship a compose file for Langfuse. Use Langfuse's own: clone
<https://github.com/langfuse/langfuse>, run `docker compose up` in its root (see the self-hosting
guide at <https://langfuse.com/self-hosting/docker-compose>), open `http://localhost:3000`, create
an organisation and a project, and create an API key pair there (a public key `pk-lf-...` and a
secret key `sk-lf-...`).

## Point the core at it

Set these in the environment of the core (not of a worker) before it starts:

| Variable | Meaning |
|---|---|
| `CULTURE_AGENTS_TRACE_ENDPOINT` | Langfuse's OpenTelemetry base, `http://localhost:3000/api/public/otel`. The core posts to `<endpoint>/v1/traces` as OTLP over HTTP (JSON) with basic auth. The host must be a loopback address (`localhost`, `127.x.x.x` or `[::1]`); any other address stops the core at start, and a redirect from the receiver is never followed, so traces stay on this host. The name `localhost` is accepted on trust in the resolver; use `127.0.0.1`. Unset: tracing is off. |
| `CULTURE_AGENTS_TRACE_PUBLIC_KEY`, `CULTURE_AGENTS_TRACE_SECRET_KEY` | The project's key pair. Read once at start, before the socket listens, then deleted from the core's `process.env` (the initial environment stays readable to the same user through `/proc/<pid>/environ`) and filtered from every worker's environment. |
| `CULTURE_AGENTS_TRACE_CONTENT` | `1` puts the prompt, tool input and output and question text on spans. Default off. |

The path `/api/public/otel/v1/traces` is from the maintainer's knowledge of Langfuse's documented
OpenTelemetry endpoint; it could not be re-read against the current documentation from the build
sandbox (no network). Confirm it against the self-hosting docs of the Langfuse version you run.

Export follows the run logs like the broker publisher does and records its position in
`traced.json` in each run directory, so a core restart sends no span twice (ids are derived from the
run id) and loses none. With the receiver stopped the core warns once, the runs are unaffected, and
spans are sent when it is back.

## What an operator can read there

One trace per run, `agents.run`, with child spans `run.submit`, `sandbox.setup` (queued until the
harness session starts), `harness.turn`, `tool.call` (one per tool call), `operator.question` (one
per question, until its answer), `result.collection` (end of the turn until the terminal state) and
`run.terminal`. Every span has `culture.run_id`, `culture.harness`, `culture.model` and
`culture.duration_ms`; the terminal state is on `run.terminal` and the root span. The log has no
event for collection, so `result.collection` is the gap between the last event of the turn and the
terminal state. The harness model is the configured one, not read from the harness.

Spans named `fleet.active_runs` (own trace) carry `culture.active_runs` per harness and model,
sent whenever the split changes. The count is the store's count of active runs, the figure the
capability report's `active_runs` states.

By default no span holds prompt text, harness output, tool input or output, question text or state
reasons.

## Live check

NOT VERIFIED: no Langfuse could be started in the build sandbox (no Docker, no network). The
exporter is proven against a local OTLP receiver in `core/test/trace/trace.test.ts`. To record a
live check, start Langfuse as above, run a run with the three variables set, and note here whether
the trace appeared with its spans.
