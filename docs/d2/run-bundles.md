# A remote run's commits and reads (D2 part two, task t26)

Status: built in `core/src/fleet/bundle.ts`, `core/src/fleet/serve-runs.ts`,
`core/src/daemon/fleet-routes.ts` and `core/src/daemon/routes.ts`, and in the
CLI (`culture_agents/cli/_commands/runs.py`, `culture_agents/cli/_fetch.py`).
It is **off by default**, like the fleet transport it runs on
(`docs/d2/fleet-transport.md`). It is control API 3.3, a MINOR addition of three
new routes and no new field (`contract/README.md`, "Changes in 3.3"). It covers
spec targets c39 and h28.

## What it does

- **`agents runs result <run_id>` on a remote run** reads the result from the
  member that executes the run (`GET /v1/fleet/runs/{id}/result`). When the run
  has a branch, the CLI asks this core for the run's bundle
  (`GET /v1/fleet/runs/{id}/bundle`). The core reads the bundle from the member
  over the fleet transport and passes it on unchanged. The CLI then checks that
  the bundle holds exactly one ref, `refs/heads/runs/<run_id>`, and fetches it
  into the caller's checkout: `--into <checkout>`, else the checkout the CLI
  runs in. Nothing uses a shell, an account or SSH on the executing host.
  Outside a checkout, or with `--no-fetch`, nothing is fetched. A repeat fetch is
  a no-op. git refuses a branch of that name that points elsewhere, and the
  CLI never overwrites one.
- **Only that run's ref.** The executing core runs
  `git bundle create <file> refs/heads/runs/<id> ^<base_commit>` in the run's
  repository. The bundle has one ref and only the commits after the run's base
  commit. No other branch, tag or commit of that host travels; the test checks
  that a commit on another branch is absent. The base commit is the bundle's
  one prerequisite, so the caller's checkout must hold it. For a remote submit
  the base commit is by default the HEAD of the caller's checkout (t23). A
  caller that submitted with `--no-base` must fetch the base commit first; the
  CLI's error says so.
- **Who may read.** This builds the owner's answer to question 8 of
  `docs/d2/part-two-design.md`: only the local operator and the member that
  submitted the run. Over the fleet transport the executing core serves the
  result, the events and the bundle only to the submitting member. Anyone else
  gets `denied`, before anything of the run is read. On the control socket the
  socket owner reads every run. Logs (`agents runs logs`) and attach across
  hosts follow the same rule, and they are **not redacted**: the caller reads
  the events exactly as the executing core stored them.
- **Bounded.** A bundle is at most 64 MiB. Its one call between cores has a 60 s
  timeout; every other call keeps 5 s. A larger bundle is refused on the
  executing core with `unsupported` (`placement`) before anything is sent. A run
  with no commits is `not_found`, and an active run is `conflict` (retryable). A
  cross-host log page holds at most 50 events.
- **Version rule.** The calling core sends the three 3.3 routes only to a member
  that announced 3.3 or later. Otherwise it answers `unsupported` (`placement`)
  and sends nothing. Show, attach, steer and cancel still work with a 3.2
  member.

## The sensitivity mark (acceptance criterion 3)

**Added, as an HTTP response header, not a schema field.** Every cross-host
response that carries a run's content as the executing core stored it carries
`Agents-Content-Sensitivity: unredacted`. These are `fleet.runs.logs`,
`fleet.runs.attach` and `fleet.runs.bundle` on the control socket, and the
member's `events` and `bundle` routes over the fleet transport. A local read
carries no mark.

Why this way: the criterion allows the mark if it costs one schema field. The
design record notes that a field on a 3.0 shape (`event_page`) would be a MAJOR
change. It also notes that the mark is cheap only as a header or inside a new
3.x route. A header costs no field at all, keeps the response shapes identical
to the local ones, and needs no change to the generated types. The CLI does
not show the header. It is there for a calling agent that reads the API
directly.

## Tests

| Rule | Test |
| --- | --- |
| The caller fetches a remote run's result, and its branch as a bundle, through the control API. The bundle holds only that run's ref and carries nothing before the base | `core/test/fleet/bundle.test.ts` (in-process cores, real git) |
| Logs and attach across hosts are the executing core's events unredacted, with the mark; a local read has none | `core/test/fleet/bundle.test.ts` |
| Another member is denied the result, the bundle and the events, and nothing of the run is read | `core/test/fleet/bundle.test.ts` |
| No commits is `not_found`, an active run `conflict`, a local run id `invalid`, and a 3.2 member is refused without a call | `core/test/fleet/bundle.test.ts` |
| `agents runs result` fetches the branch into `--into` or the current checkout; nothing outside a checkout or with `--no-fetch`; a checkout without the base is told so; a bundle with other refs, or not a bundle, is refused; `runs logs` uses the fleet route | `tests/test_cli_run_bundle.py` |
| Two real core processes, the real CLI and the stub harness: the caller's own checkout receives thor's run branch, with ssh disabled for the CLI, and the caller's logs equal thor's | `tests/acceptance/d2/test_remote_runs.py` |

## Not verified

- Two real hosts. Everything above ran on loopback on one machine (task t28).
- A bundle near the 64 MiB cap, and the 60 s timeout on a slow link: neither
  was measured.
- The Claude Code and OpenCode harnesses: the tests use the fake service and
  the stub harness.
