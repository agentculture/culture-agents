# D0 inventory: agentirc, cultureagent, agent-lifecycle

Inventory of the three repos that issue
[#2](https://github.com/agentculture/culture-agents/issues/2) plans to
consolidate or replace: what each one does, which contracts it exposes, and who
consumes it. It is the D0 deliverable that later tasks build on.

It was written on 2026-11-25 against the upstream `main` of each repo, read
through `gh` and throw-away shallow clones, never through the sibling checkouts
under `/home/ori/git/` (those are stale and dirty; their state is frozen in
[`sibling-baseline.txt`](sibling-baseline.txt)).

## Pinned commits

Every citation below is written as `` `repo:path:line` `` or
`` `repo:path:first-last` `` and resolves at the commit pinned here.
`scripts/check-d0-citations.py` re-checks that each cited path exists at the
pinned commit and is at least that long.

| Repo | Commit | Version | Why it is cited |
| --- | --- | --- | --- |
| agentirc | `3159b0e99805182d55ddce520333c692088e90dc` | 9.14.1 | Inventoried (IRCd, replaced by culture-chat) |
| cultureagent | `403f4dd509774504c8ff50d42619797d202f33d9` | 0.17.0 | Inventoried (harness wrappers, bridges; merges in) |
| agent-lifecycle | `81436b6c482be361dbeae898858cc3d2c5357fa0` | 0.11.0 | Inventoried (supervision core; merges in) |
| culture | `9217b4163319c86461949eb94e019cbcaf2f93c6` | 14.x | Consumer of all three; hosts the chat-coupled boot |
| colleague | `6081b8c82373b3242e630656510e82dc84eeeaed` | not verified | Consumer of agent-lifecycle |
| culture-rules | `08be157cb55742019e5f6523db94b538065ae602` | not verified | Consumer of the cultureagent bridge |
| irc-lens | `592ea2c214f994f13f338b182cd94461a15f831f` | 0.23.0 | Peer of agentirc; own IRC client |

Method and limits:

- Line numbers come from the pinned commit. The scope leads `s1`-`s39` in the
  spec cited older checkouts, and several had drifted; for example
  `docs/bridges.md:172-173` is now lines 197-198 and `base_daemon.py:1158-1159`
  is now 1198-1199. Nothing here is copied from the leads without a re-check.
- A citation proves the file and line exist, not that the prose is right. The
  checker's `--show` flag prints each cited line for a human read; the prose was
  read against those lines once, by the author.
- Consumers were found by grepping the pinned clones of culture, colleague,
  culture-rules and irc-lens. Repos not cloned (embodiment, codexd, steward,
  guildmaster, associate, culture-nodes, lobes-cli) are **not verified** here;
  the spec's scope leads `s10`, `s14`-`s19` and `s21`-`s26` are the only record.
- Test suites were not run and not read beyond file names. Nothing here claims a
  behaviour works, only that the code or doc says so.

## agentirc 9.14.1

A Python asyncio IRCd with agent-oriented extensions, shipped as the PyPI dist
`agentirc-cli` (`agentirc:pyproject.toml:2-3`). Runtime dependencies are
OpenTelemetry, aiohttp, pyyaml and jinja2 (`agentirc:pyproject.toml:28-36`).
Source is about 14.7k lines across `agentirc/`; the largest modules are
`agentirc/client.py` (2395 lines), `agentirc/server_link.py` (1286),
`agentirc/ircd.py` (1047) and `agentirc/skills/rooms.py` (980).

### agentirc features and subsystems

- **IRCd core.** `IRCd` is the embeddable server object, with `start`, `stop`
  and `emit_event` (`agentirc:agentirc/ircd.py:41`,
  `agentirc:agentirc/ircd.py:189`, `agentirc:agentirc/ircd.py:339`,
  `agentirc:agentirc/ircd.py:571`). Per-connection protocol handling is in
  `agentirc:agentirc/client.py:1`; remote users are mirrored by
  `agentirc:agentirc/remote_client.py:1`.
- **Federation.** `agentirc:agentirc/server_link.py:1` carries server-to-server
  links. Remote nicks must start with `<peer>-`
  (`agentirc:agentirc/server_link.py:491-505`). Inbound `SEVENT` strips
  peer-supplied underscore keys and stamps the origin from the link
  (`agentirc:agentirc/server_link.py:977-1030`). Reconnect backfill is
  `agentirc:agentirc/server_link.py:1043-1078`.
- **Federation limits that matter for the A-B-C case.** A relayed event is not
  re-relayed: `agentirc:agentirc/ircd.py:368-369` relays only when the event has
  no `_origin` tag, and backfill skips `_origin` events
  (`agentirc:agentirc/server_link.py:1048-1054`). The `SEVENT` sequence number
  is read and discarded (`agentirc:agentirc/server_link.py:990`), and the only
  sequence state is per-peer `last_seen_seq` plus a 10000-event ring
  (`agentirc:agentirc/server_link.py:131`, `agentirc:agentirc/ircd.py:59-60`).
  No (origin, seq) dedup table was found by grep; that absence is a search
  result, not a proof.
- **Trace propagation.** The `culture.dev/traceparent` IRCv3 tag is injected on
  relay (`agentirc:agentirc/server_link.py:149-154`) and extracted on receipt
  (`agentirc:agentirc/server_link.py:293-298`).
- **Skills (server-side feature modules).** Presence
  (`agentirc:agentirc/skills/presence.py:144`), rooms
  (`agentirc:agentirc/skills/rooms.py:32`), threads
  (`agentirc:agentirc/skills/threads.py:66`), history
  (`agentirc:agentirc/skills/history.py:223`) and icon
  (`agentirc:agentirc/skills/icon.py:14`), on the base class
  `agentirc:agentirc/skill.py:20`.
- **Agent accounts and SASL PLAIN.** The credential table and grant levels are
  `agentirc:agentirc/accounts.py:63`, `agentirc:agentirc/accounts.py:209`, with
  an auth-failure limiter at `agentirc:agentirc/accounts.py:466`. Wire constants
  are `agentirc:agentirc/protocol.py:290-296`.
- **Bot framework.** `Bot`, `BotManager`, `BotConfig`
  (`agentirc:agentirc/bots/bot.py:73`, `agentirc:agentirc/bots/bot_manager.py:50`,
  `agentirc:agentirc/bots/config.py:59`) with a `bot` CLI noun
  (`agentirc:agentirc/bots/cli.py:47-96`). Event subscription verbs `EVENTSUB`,
  `EVENTPUB` and the `agentirc.io/bot` capability are
  `agentirc:agentirc/protocol.py:278-286`.
- **Telemetry and audit.** OpenTelemetry settings and the audit directory
  default are `agentirc:agentirc/config.py:23-40`.
- **In-process agent client.** `AgentClient` is
  `agentirc:agentirc/agent_client.py:102`.

### agentirc public contracts

- **CLI entry points.** Two console scripts, `agentirc` and `agentirc-cli`, both
  `agentirc.cli:main` (`agentirc:pyproject.toml:52-54`). Server verbs `serve`,
  `start`, `stop`, `restart`, `status`, `link`, `logs`, `version`
  (`agentirc:agentirc/cli.py:279-320`); agent-facing client verbs `send`,
  `read`, `watch`, `join` (`agentirc:agentirc/cli.py:352-382`). In-process
  callers use `dispatch(argv) -> int` (`agentirc:agentirc/cli.py:878`) and
  `main` (`agentirc:agentirc/cli.py:903`).
- **Import paths promised stable.** Seven modules: `agentirc.config`,
  `agentirc.cli`, `agentirc.protocol`, `agentirc.ircd`,
  `agentirc.virtual_client`, `agentirc.bots`, `agentirc.agent_client`
  (`agentirc:docs/api-stability.md:3-24`). Config classes are `LinkConfig`,
  `TelemetryConfig`, `PresenceConfig`, `AccountsConfig` and `ServerConfig` with
  `from_yaml` (`agentirc:agentirc/config.py:12`,
  `agentirc:agentirc/config.py:179`, `agentirc:agentirc/config.py:209`).
- **Wire protocol.** IRC plus IRCv3 tags and CAP/SASL, with agentirc verbs
  (`EVENTSUB`, `EVENTPUB`, `SEVENT`, `VERBS`:
  `agentirc:agentirc/protocol.py:170`, `agentirc:agentirc/protocol.py:278-286`,
  `agentirc:agentirc/protocol.py:318-332`). No HTTP API on the IRCd itself.
- **Webhook port: docs and code disagree.** `agentirc:docs/api-stability.md:50-54`
  says `webhook_port` is "accepted in config but no longer bound";
  `agentirc:agentirc/ircd.py:211-217` says `BotManager.start()` binds the
  webhook listener "since 9.7.0" when the port is set. Which is true at runtime
  was not verified; D0 should settle it before anyone depends on either.
- **On-disk data.** Paths are in the table at
  `agentirc:docs/deployment.md:15-26`: `~/.culture/server.yaml`, per-server logs,
  PID and port files (`agentirc:agentirc/_internal/pidfile.py:21`), audit JSONL,
  `<data-dir>/history.db` (SQLite WAL; `agentirc:agentirc/history_store.py:14-20`),
  and a runtime socket directory. Other stores: rooms
  (`agentirc:agentirc/room_store.py:13-14`), threads
  (`agentirc:agentirc/thread_store.py:13-14`) and `accounts.json`
  (`agentirc:agentirc/accounts.py:58`). The `~/.culture` default means the path
  names an older product, not culture-chat.

### agentirc known consumers

- **culture** forwards `culture server <verb>` to `agentirc.cli.dispatch`
  (`culture:culture_core/cli/__init__.py:142-158`,
  `culture:culture_core/cli/server.py:92`,
  `culture:culture_core/cli/server.py:329-335`), runs `IRCd` in-process
  (`culture:culture_core/cli/server.py:825-848`), and imports config, bot,
  accounts and telemetry types (for example `culture:culture_core/config.py:18`,
  `culture:culture_core/bots/bot_manager.py:12`,
  `culture:culture_core/accounts.py:214`). It pins `agentirc-cli>=9.14.0,<10`
  (`culture:pyproject.toml:27`). A grep of `culture_core` finds 21 import sites.
- **cultureagent** depends on `agentirc-cli>=9.6,<10`
  (`cultureagent:pyproject.toml:18`) and imports only config and protocol types
  for telemetry (`cultureagent:cultureagent/telemetry/audit.py:29`,
  `cultureagent:cultureagent/telemetry/tracing.py:14`,
  `cultureagent:cultureagent/telemetry/metrics.py:18`). Its IRC client is its
  own transport, not agentirc's (`cultureagent:cultureagent/clients/shared/irc_transport.py:76`).
- **colleague** has `agentirc-cli>=9.6,<10` in its optional `culture` extra
  (`colleague:pyproject.toml:104-105`); it has no `import agentirc` line.
- **culture-rules** has `agentirc-cli>=9.12` in an optional `agent` extra,
  imported lazily (`culture-rules:pyproject.toml:25`,
  `culture-rules:culture_rules/actors/agent.py:328`).
- **irc-lens** does not depend on agentirc; it opens a raw socket
  (`irc-lens:src/irc_lens/irc/transport.py:114`). culture pins it
  (`culture:pyproject.toml:53`). Treat it as a second IRC client implementation
  that moves with culture-chat, not with agentirc.
- **embodiment, codexd, steward, guildmaster, lobes-cli:** not verified. Spec
  lead `s10` records that codexd and embodiment ship their own raw IRC clients.

## cultureagent 0.17.0

The agent runtime for the Culture mesh: per-backend daemons that join IRC, plus
three HTTP "bridges" that run one coding agent per invocation in a git worktree.
The dist is `cultureagent` (`cultureagent:pyproject.toml:2-3`); it requires
`agentirc-cli`, pyyaml and OpenTelemetry (`cultureagent:pyproject.toml:16-24`).
Backend SDKs sit in extras
(`cultureagent:pyproject.toml:30-45`); the `bridges` extra is deliberately empty
so the bridges stay stdlib-only (`cultureagent:pyproject.toml:44`). 385 tracked
files. Files over the 400-line cap include
`cultureagent:cultureagent/bridges/core/preflight.py` (1017 lines),
`cultureagent:cultureagent/bridges/core/reap.py` (909),
`cultureagent:cultureagent/bridges/core/runner.py` (658),
`cultureagent:cultureagent/clients/shared/base_daemon.py` (1234) and
`cultureagent:cultureagent/bridges/core/server.py` (553); the full list was not
re-measured here.

### cultureagent features and subsystems

- **Resident IRC daemons, five backends.** `BaseDaemon` is the shared
  template (`cultureagent:cultureagent/clients/shared/base_daemon.py:70`), and
  `QueuedBaseDaemon` adds a FIFO mention queue
  (`cultureagent:cultureagent/clients/shared/queued_base_daemon.py:30`). Backend
  daemons: claude (`cultureagent:cultureagent/clients/claude/daemon.py:45`),
  codex (`cultureagent:cultureagent/clients/codex/daemon.py:34`), copilot
  (`cultureagent:cultureagent/clients/copilot/daemon.py:26`), acp
  (`cultureagent:cultureagent/clients/acp/daemon.py:86`) and colleague
  (`cultureagent:cultureagent/clients/colleague/daemon.py:165`).
- **Shared harness machinery.** IRC transport with SASL PLAIN
  (`cultureagent:cultureagent/clients/shared/irc_transport.py:76`,
  `cultureagent:cultureagent/clients/shared/irc_transport.py:124`; the contract
  is `cultureagent:docs/sasl.md:1-30`), the per-agent Unix-socket IPC server
  (`cultureagent:cultureagent/clients/shared/socket_server.py:26`), attention
  tracking (`cultureagent:docs/attention.md:1`), message buffer
  (`cultureagent:cultureagent/clients/shared/message_buffer.py:24`), presence
  emitter (`cultureagent:cultureagent/clients/shared/presence_emitter.py:147`),
  webhooks and OTel observer.
- **Bridges (qwen, codex, claude).** Three stdlib HTTP servers sharing
  `cultureagent.bridges.core`, one agent per invocation in a worktree, never
  pushing (`cultureagent:docs/bridges.md:1-20`). Core pieces: the HTTP server
  (`cultureagent:cultureagent/bridges/core/server.py:1`), the runner that owns
  agent subprocesses (`cultureagent:cultureagent/bridges/core/runner.py:153`),
  the idempotency store (`cultureagent:cultureagent/bridges/core/idempotency.py:42`),
  git worktree provisioning (`cultureagent:cultureagent/bridges/core/workspace.py:1`),
  read-only violation detection
  (`cultureagent:cultureagent/bridges/core/readonly.py:1`), preserve-on-failure
  (`cultureagent:cultureagent/bridges/core/preserve.py:1`), the worktree reaper
  (`cultureagent:cultureagent/bridges/core/reap.py:1`,
  `cultureagent:cultureagent/bridges/core/reclaim.py:1`), host preflight and
  liveness facts (`cultureagent:cultureagent/bridges/core/preflight.py:1`,
  `cultureagent:cultureagent/bridges/core/liveness.py:1`) and callback delivery
  (`cultureagent:cultureagent/bridges/core/callbacks.py:1`).
- **Safety behaviour already built.** The child environment drops push
  credentials (`cultureagent:cultureagent/bridges/core/agentproc.py:20-31`);
  the bridge's git helper refuses `push` and every cache repo gets an unusable
  push URL (`cultureagent:cultureagent/bridges/core/workspace.py:40-52`).
  D1 carries neither forward by default (spec lead `s32`).
- **Per-backend bridge drivers.** Claude drives `claude -p --output-format
  stream-json` (`cultureagent:cultureagent/bridges/claude/claude_cli.py:1-14`),
  codex drives `codex exec --json`
  (`cultureagent:cultureagent/bridges/codex/codex_cli.py:1-14`), and qwen drives
  ACP over stdio (`cultureagent:cultureagent/bridges/qwen/acp/driver.py:1`).
- **Introspection CLI.** `whoami`-style verbs only: `learn`, `explain`,
  `overview`, `doctor`, `cli overview`
  (`cultureagent:cultureagent/cli/__init__.py:38-63`); no dispatch verbs.

### cultureagent public contracts

- **CLI entry points** (`cultureagent:pyproject.toml:56-60`): `cultureagent`,
  `cultureagent-qwen-bridge`, `cultureagent-codex-bridge`,
  `cultureagent-claude-bridge`. Bridge flags and exit codes (0 ok, 1 arguments,
  2 environment) are `cultureagent:docs/bridges.md:22-37`.
- **Bridge HTTP API**, authenticated by a bearer token except `/healthz`
  (`cultureagent:docs/bridges.md:78-82`). Routes are listed in
  `cultureagent:cultureagent/bridges/core/server.py:11-23` and matched at
  `cultureagent:cultureagent/bridges/core/server.py:55-57`:
  `POST /v1/invocations` with a required `Idempotency-Key`
  (`cultureagent:docs/bridges.md:83-100`), `GET /v1/invocations/<id>`
  (`cultureagent:docs/bridges.md:192-198`), `POST .../cancel` and `DELETE`
  (`cultureagent:docs/bridges.md:200-204`), `GET /v1/capabilities` and
  `GET /healthz` (`cultureagent:docs/bridges.md:206-215`). There is no steer,
  answer, pause or resume route.
- **Result schema** `cultureagent.bridge.result/v1`
  (`cultureagent:cultureagent/bridges/core/result.py:50`,
  `cultureagent:docs/bridges.md:217-255`). Statuses include `completed`,
  `failed`, `timed_out`, `cancelled`, `rejected`; there is no
  waiting-for-operator status.
- **Callback events** `accepted`, `progress`, `heartbeat`, `completed`,
  `failed`, with per-invocation sequence numbers
  (`cultureagent:docs/bridges.md:169-190`).
- **Python import paths promised stable through 0.x**
  (`cultureagent:docs/api-stability.md:8-16`): shared-tier modules
  (`cultureagent:docs/api-stability.md:18-35`), `SkillClient`
  (`cultureagent:docs/api-stability.md:42-66`), per-backend config classes
  (`cultureagent:docs/api-stability.md:68-91`) and the daemon classes
  (`cultureagent:docs/api-stability.md:100-117`).
- **On-disk data.** Bridge state under `state_dir`
  (`cultureagent:cultureagent/bridges/core/config.py:63-65`): `results/<id>.json`
  (`cultureagent:cultureagent/bridges/core/runner.py:162`), idempotency records
  (`cultureagent:cultureagent/bridges/core/idempotency.py:53-58`), `worktrees/`
  and `repos/` (`cultureagent:cultureagent/bridges/core/config.py:104-107`).
  Daemons write `agent-<nick>` PID files
  (`cultureagent:cultureagent/clients/shared/base_daemon.py:186`,
  `cultureagent:cultureagent/clients/shared/base_daemon.py:197`) and a
  `culture-<nick>.sock` Unix socket
  (`cultureagent:cultureagent/clients/shared/base_daemon.py:102-105`).
  `CULTURE_AGENT_SECRET` is read once and popped from the environment
  (`cultureagent:cultureagent/clients/shared/base_daemon.py:95-100`).
  Per-backend `culture.yaml` and `SKILL.md` files ship in the wheel
  (`cultureagent:pyproject.toml:69-80`).

### cultureagent known consumers

- **culture** (86 sites per spec lead `s25`; re-measured as **47** import lines
  in `culture_core` at the pinned commit, tests excluded). Many are one-line
  re-export shims such as
  `culture:culture_core/clients/shared/rooms.py:8` and
  `culture:culture_core/clients/claude/config.py:10`. Daemons are imported at
  start time (`culture:culture_core/cli/agents.py:843`,
  `culture:culture_core/cli/agents.py:875`,
  `culture:culture_core/cli/agents.py:888`), and the bundled SKILL.md is read
  from the package (`culture:culture_core/cli/skills.py:90-91`). Pins:
  `cultureagent~=0.16.0` (`culture:pyproject.toml:33`) and backend extras
  (`culture:pyproject.toml:112-126`). `~=0.16.0` excludes the pinned 0.17.0.
- **culture-rules** reaches the bridges over plain HTTP only
  (`culture-rules:culture_rules/actors/agent.py:33`,
  `culture-rules:culture_rules/actors/agent.py:347`,
  `culture-rules:culture_rules/actors/agent.py:849`), with cancel at
  `culture-rules:culture_rules/actors/agent.py:1188`. It has no import of or pin on
  cultureagent.
- **colleague** is a dependency of cultureagent, not a consumer: the
  `backend-colleague` extra pulls `colleague[culture]`
  (`cultureagent:pyproject.toml:39`).
- **embodiment, codexd, culture-nodes:** not verified. Spec lead `s26` says
  the bridges were cited from culture-nodes' adapters
  (`cultureagent:docs/bridge-sources.md:1`).

## agent-lifecycle 0.11.0

A zero-dependency Python library: a harness- and transport-agnostic process
lifecycle core (`agent-lifecycle:pyproject.toml:2-3`,
`agent-lifecycle:pyproject.toml:16`). 139 tracked files; about 3100 lines under
`agent_lifecycle/`. Its scope charter is
`agent-lifecycle:docs/scope-charter.md:9-38`.

### agent-lifecycle features and subsystems

- **Pluggable seams.** `Transport` and optional `Presence`
  (`agent-lifecycle:agent_lifecycle/runtime/transport.py:28`,
  `agent-lifecycle:agent_lifecycle/runtime/transport.py:64`), `Harness`
  (`agent-lifecycle:agent_lifecycle/runtime/harness.py:27`), and the immutable
  `Message` value object
  (`agent-lifecycle:agent_lifecycle/runtime/message.py:16`).
- **In-process supervisor.** `Supervisor` pumps messages between a Transport
  and a Harness (`agent-lifecycle:agent_lifecycle/runtime/supervisor.py:53`);
  its states are at `agent-lifecycle:agent_lifecycle/runtime/supervisor.py:37`.
- **OS-process supervisor.** `ProcessSupervisor` spawns, waits on, stops (SIGTERM
  then SIGKILL) and health-monitors one child
  (`agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:108-125`,
  `agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:178`,
  `agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:235`,
  `agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:300`). It keeps
  the child only as an in-memory handle
  (`agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:145`).
- **Restart policy.** Backoff, restart budget and a `RestartingSupervisor` with
  states idle, running, stopped_clean, gave_up
  (`agent-lifecycle:agent_lifecycle/runtime/restart_policy.py:30`,
  `agent-lifecycle:agent_lifecycle/runtime/restart_policy.py:114`,
  `agent-lifecycle:agent_lifecycle/runtime/restart.py:75-103`).
- **Health.** `ReadinessTracker` and `HealthThreshold`
  (`agent-lifecycle:agent_lifecycle/runtime/health.py:74`,
  `agent-lifecycle:agent_lifecycle/runtime/health.py:129`).
- **Observer seam.** `RuntimeObserver` with process and message hooks, and
  `NullObserver`
  (`agent-lifecycle:agent_lifecycle/runtime/observer.py:42`,
  `agent-lifecycle:agent_lifecycle/runtime/observer.py:186`).
- **Batch classification.** `BatchOutcome` is `ok`, `failed`, `timeout`,
  `incomplete` (`agent-lifecycle:agent_lifecycle/runtime/batch.py:68-92`) and
  `classify_batch` maps an exit to one
  (`agent-lifecycle:agent_lifecycle/runtime/batch.py:95`).
- **Spawn and exit values.** `SpawnSpec` and `ExitOutcome`
  (`agent-lifecycle:agent_lifecycle/runtime/process.py:27`,
  `agent-lifecycle:agent_lifecycle/runtime/process.py:63`).
- **Reference doubles** that prove the seams in-process:
  `agent-lifecycle:agent_lifecycle/reference/echo_harness.py:1`,
  `agent-lifecycle:agent_lifecycle/reference/echo_transport.py:1`,
  `agent-lifecycle:agent_lifecycle/reference/recording_observer.py:1`.

### agent-lifecycle public contracts

- **CLI entry point:** `agent-lifecycle` (`agent-lifecycle:pyproject.toml:22-23`),
  introspection verbs only: `whoami`, `learn`, `explain`, `overview`, `doctor`,
  `cli overview`
  (`agent-lifecycle:agent_lifecycle/cli/_commands/whoami.py:101`,
  `agent-lifecycle:agent_lifecycle/cli/_commands/learn.py:89`,
  `agent-lifecycle:agent_lifecycle/cli/_commands/explain.py:27`,
  `agent-lifecycle:agent_lifecycle/cli/_commands/overview.py:109`,
  `agent-lifecycle:agent_lifecycle/cli/_commands/doctor.py:116`,
  `agent-lifecycle:agent_lifecycle/cli/_commands/cli.py:30`).
- **Import path:** `agent_lifecycle.runtime` re-exports `HealthMonitorResult`,
  `HealthThreshold`, `NullObserver`, `ProcessExitResult`, `ProcessSupervisor`,
  `Readiness`, `ReadinessTracker`, `RestartingSupervisor`, `RestartState` and
  `RuntimeObserver` (`agent-lifecycle:agent_lifecycle/runtime/__init__.py:9-29`).
  Consumers also import submodules directly (`runtime.supervisor`,
  `runtime.message`, `runtime.transport`, `runtime.observer`).
- **Documented seams:** `agent-lifecycle:docs/runtime-seam.md:1-40` and the
  library-embed contract for colleague
  (`agent-lifecycle:docs/colleague-embed.md:13-60`, batch semantics at
  `agent-lifecycle:docs/colleague-embed.md:137-210`).
- **No schemas and no HTTP.** The package has no network endpoint and no HTTP
  API.
- **On-disk data: none found.** A grep of `agent_lifecycle/runtime` for
  `open(`, `write_text`, `json.dump` and `sqlite` found nothing; so supervision
  state is held in memory only. That is the root of the restart-recovery gap
  below.

### agent-lifecycle known consumers

- **cultureagent** imports the Supervisor, observer, message and presence types
  in its refit backends: claude
  (`cultureagent:cultureagent/clients/claude/runtime/wiring.py:91-92`,
  `cultureagent:cultureagent/clients/claude/runtime/harness.py:40`,
  `cultureagent:cultureagent/clients/claude/runtime/transport.py:72`,
  `cultureagent:cultureagent/clients/claude/runtime/presence.py:33`), acp
  (`cultureagent:cultureagent/clients/acp/runtime/wiring.py:85-86`), colleague
  (`cultureagent:cultureagent/clients/colleague/runtime/wiring.py:79-81`) and the
  shared OTel observer
  (`cultureagent:cultureagent/clients/shared/otel_observer.py:45`). Only the
  `backend-claude` extra declares the dependency
  (`cultureagent:pyproject.toml:30`); the `backend-acp` extra does not list it
  (`cultureagent:pyproject.toml:33`) although acp imports it, so whether acp
  gets it transitively was not verified. The codex and copilot daemons do not
  import it (grep found no such line under those directories).
- **colleague** imports it in four modules under `colleague/resident/`:
  `colleague:colleague/resident/appserver.py:206-207`,
  `colleague:colleague/resident/appserver.py:235`,
  `colleague:colleague/resident/supervisor.py:22`,
  `colleague:colleague/resident/harness.py:31`,
  `colleague:colleague/resident/transport.py:33`. It pins `agent-lifecycle>=0.9`
  in two extras (`colleague:pyproject.toml:92`, `colleague:pyproject.toml:104`).
  Whether `colleague/cli.py` reaches resident code indirectly was not traced.
- **culture** has no `agent_lifecycle` import; the only mention found is a
  comment (`culture:culture_core/cli/skills.py:35`).

## Gaps D1 must close

These are the two gaps that motivate the control plane. Both are
current-behaviour findings at the pinned commits, not proposals.

### Gap 1: one-shot bridges cannot steer and lose in-flight runs on restart

- **No steering or answering.** The route table has no such verb
  (`cultureagent:cultureagent/bridges/core/server.py:11-23`); the only
  mid-run control is a best-effort SIGTERM cancel
  (`cultureagent:docs/bridges.md:200-204`,
  `cultureagent:cultureagent/bridges/core/runner.py:230-244`). The transports
  are one-shot subprocess modes with resume deliberately removed: the Claude
  driver's header lists "no resume"
  (`cultureagent:cultureagent/bridges/claude/claude_cli.py:1-14`), as does the
  codex driver (`cultureagent:cultureagent/bridges/codex/codex_cli.py:1-14`). The
  resident daemons' question path says "Response matching is TODO"
  (`cultureagent:cultureagent/clients/shared/base_daemon.py:1198-1199`).
- **In-flight runs read as unknown after a restart.** The doc states it
  directly: "A run that was in flight when the bridge restarted is not resumed
  and reads as unknown" (`cultureagent:docs/bridges.md:192-198`). The code
  matches: live runs are in a per-process dictionary
  (`cultureagent:cultureagent/bridges/core/runner.py:161`) holding a `Popen`
  handle (`cultureagent:cultureagent/bridges/core/runner.py:64`); `status` falls
  back to `results/<id>.json`, which exists only for finished runs
  (`cultureagent:cultureagent/bridges/core/runner.py:245-265`), and otherwise
  returns `None`, which the server answers as HTTP 404
  (`cultureagent:cultureagent/bridges/core/server.py:277-281`).
- **The same shape one layer down.** agent-lifecycle's `ProcessSupervisor` also
  holds only an in-memory process handle
  (`agent-lifecycle:agent_lifecycle/runtime/process_supervisor.py:145`), and
  its `BatchOutcome` has no cancelled or waiting-for-operator member
  (`agent-lifecycle:agent_lifecycle/runtime/batch.py:68-92`).
- **What D1 must therefore supply:** durable run identity and state, a control
  channel beyond SIGTERM, and a recovery path that reports "daemon restarted,
  worker status from log" rather than an unknown or an invented success.

### Gap 2: agents in culture boot only through the chat server

- **Start is gated on a TCP probe of the IRC server.** `culture agents start`
  calls `_probe_server_connection` before it forks or starts anything
  (`culture:culture_core/cli/agents.py:768`); the probe opens a socket to the
  chat host and port and raises "cannot connect to IRC server" with a hint to
  run `culture server start` (`culture:culture_core/cli/agents.py:636-657`).
- **The daemon itself needs the chat server to finish starting.** `BaseDaemon.start`
  connects its IRC transport (`cultureagent:cultureagent/clients/shared/base_daemon.py:237-240`)
  before it opens the agent's control socket and initialises the session
  (`cultureagent:cultureagent/clients/shared/base_daemon.py:247-253`), and the
  transport raises a `ConnectionError` ("is the server running?") when the
  connection fails (`cultureagent:cultureagent/clients/shared/irc_transport.py:217-222`).
  The foreground path and each background child reach daemon start through
  `culture:culture_core/cli/agents.py:957-973`
  (called from `culture:culture_core/cli/agents.py:685` and
  `culture:culture_core/cli/agents.py:1065`).
- **Work arrives as IRC mentions.** The daemon's input is the IRC transport's
  `on_mention` callback (`cultureagent:cultureagent/clients/shared/base_daemon.py:696`),
  so without chat there is no way to hand a resident daemon work except its
  Unix-socket IPC (`cultureagent:cultureagent/clients/shared/base_daemon.py:102-105`).
- **Not verified:** whether an already-running daemon survives the chat server
  dying mid-run (that depends on `IRCTransport` reconnect behaviour, which was
  not traced), so the claim "a dead chat server kills a run" is established for
  start only.

## Findings that change the plan

- `docs/bridges.md` and several cited lines had drifted from the spec's leads
  (see the Method note above); anything citing the old numbers is stale.
- The two stability promises overlap: cultureagent promises its import paths
  "behavior-stable through the entire 0.x line" (`cultureagent:docs/api-stability.md:10`)
  and culture pins `~=0.16.0`, so consolidation is a migration with a deprecation
  cycle, not a move.
- agentirc's docs and code disagree on the webhook listener (see agentirc
  contracts); decide the truth before replacing the server.
- Version skew at the pinned commits: culture pins agentirc `>=9.14.0` and
  cultureagent `~=0.16.0`, while cultureagent main is 0.17.0 (which adds the
  claude bridge's `operate` role) and agent-lifecycle main is 0.11.0 against
  consumers pinning `>=0.9`.
