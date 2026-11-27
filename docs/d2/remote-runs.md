# Remote runs (D2 part two, task t23)

Status: built in `core/src/fleet/` (`remote.ts`, `serve-runs.ts`,
`remote-attach.ts`, `aliases.ts`) and `core/src/daemon/fleet-routes.ts`,
**off by default**, like the transport it runs on
(`docs/d2/fleet-transport.md`). It is control API 3.2, a MINOR addition
(`contract/README.md`, "Changes in 3.2"). It builds Decisions 4 and 5 of
`docs/d2/part-two-design.md` as that record recommends. Admission across hosts
(t24) and fetching a run's commits as a bundle
(t26) are not built.

## What it does

- **The caller chooses the host.** `agents runs submit --alias <name>` on the
  calling host sends the run, through the local core and over the fleet
  transport, to the member that the node of `--agent` names. Nothing
  schedules. `agents runs show`, `attach`, `steer` and `cancel` reach the
  member that the node of a run id names. The local core forwards each request
  to the same path on that member and checks the answer against the contract.
- **Only a listed, authenticated member.** A call goes only to a member
  listed now in the member list (`docs/d2/fleet-members.md`), and only to an
  address of the local `peers.json` whose last announcement reply was
  authenticated as that member's key. The transport checks that key again on
  the call. A member that is not listed, or that has no such address, is
  `unavailable`.
- **The repository is an alias the executing host defines.** Each host keeps
  a local, untracked
  `${XDG_CONFIG_HOME:-$HOME/.config}/culture-agents/fleet/aliases.json`:

  ```json
  { "version": 1, "aliases": [{ "alias": "culture-agents", "repo": "/abs/path" }] }
  ```

  The alias resolves to a path on that host, and the allow-list applies to
  that path unchanged. No path crosses the network: the remote submit has no
  `repo` field, and a remote run as a caller sees it has no path.
  `agents agents aliases --member <node>` lists a member's aliases and what its
  allow-list permits on each. That two hosts' aliases name the same project is
  the operators' claim; the core checks only a named commit.
- **The base commit.** The CLI sends the HEAD of the git checkout it runs in
  (the design record's question 9, at its recommended answer). `--base <sha>`
  names another commit, and `--no-base` names none. The executing core refuses
  a commit its aliased checkout lacks with `invalid` (`field: /base_commit`)
  and fetches nothing. Without a commit the run starts from the executing
  host's HEAD at acceptance. The response names the commit either way.
- **The deadline is a duration.** `--deadline-in <seconds>` becomes
  `deadline_ms`. The executing core adds it to its own clock when it accepts
  the submit. No timestamp from one host is compared with a clock on another.
  An absolute `--deadline` is refused for a remote run.
- **Submitter and authority.** The run's submitter on the executing core is
  `{ "kind": "member", "node": "<the caller's trust-list name>" }`. A member
  may show, read the events of, attach to, steer and cancel only the runs it
  submitted. Any other run is `denied`, and no setting widens this. The
  executing host's operator keeps full control of every run through the
  control socket. A member's submit keys live in that member's own namespace.
- **Version rule between cores.** A member serves a call from any core of the
  same MAJOR, whatever the two MINORs. The caller sends a remote-run route only
  to a member that announced 3.2 or later, and otherwise answers `unsupported`
  (`placement`) without sending anything. A core of another MAJOR is refused
  `incompatible_version` both ways. So a fleet upgrades one host at a time.
- **Bounded.** Every call to a member has a 5 second timeout and a read cap:
  1 MiB for an answer, 8 MiB for one page of events. Attach on the calling
  core reads the member's events a page at a time (at most 10 a call, every
  250 ms while there is nothing new) and streams them to the operator as SSE,
  so no read from the network is unbounded and no call can hang. A request
  body on the member is capped at 1 MiB. A member that does not answer is
  `unavailable` (`runs show` reads the unreachable view instead,
  `docs/d2/unreachable-view.md`). Nothing about a remote run is stored on the
  calling core.

## Key handling

Unchanged from t21: the fleet key is taken from the environment with the
other injected secrets before any socket listens, and dropped from workers and
host commands. It stays readable in the core's own `/proc/<pid>/environ` to
processes of the same user for as long as the core runs, as the owner accepted
(design record, question 3).

## Tests

| Rule | Test |
| --- | --- |
| A submit runs on another core and is shown, attached, steered and cancelled from the caller; the submitter is the member | `core/test/fleet/remote.test.ts` (in-process cores), `core/test/fleet/remote-e2e.test.ts` (two real core processes, real worker), `tests/acceptance/d2/test_remote_runs.py` (two built cores, the real CLI, the stub harness) |
| The deadline is a duration evaluated on the executing core's clock; two clocks 1 hour apart either way give the same run length | `core/test/fleet/remote.test.ts`, injected clocks |
| A 3.2 core and a core that reports 3.1 call each other in both directions; another MAJOR is refused | `core/test/fleet/remote-version.test.ts` |
| The repository is an alias resolved to an allow-listed path; a path, an unknown alias and a path the allow-list does not permit are refused | `core/test/fleet/remote.test.ts` |
| A named commit the executing checkout lacks is refused `invalid` | `core/test/fleet/remote.test.ts`, `tests/acceptance/d2/test_remote_runs.py` |
| A member acts only on its own runs; the local operator on any | `core/test/fleet/remote.test.ts` |
| A member that does not answer is `unavailable` within one call timeout | `core/test/fleet/remote.test.ts` |
| The CLI: `--alias`, `--base`, `--no-base`, `--deadline-in`, the run id's node, `agents agents aliases` | `tests/test_cli_remote_runs.py` |

## Not verified

- Two real hosts: everything above ran on loopback on one machine (task t28).
- Clock difference between real hosts: the 1 hour offset was injected, not
  measured.
- A real 3.1 core: the version test uses this build reporting 3.1. A real 3.1
  core serves only version, announce and the member list over the transport,
  which is what the caller relies on.
- The Claude Code and OpenCode harnesses on a remote run: the tests use the
  fake driver and the stub harness.
