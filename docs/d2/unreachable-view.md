# The unreachable view (D2 part two, task t25)

Status: built, in control API 3.3 (`contract/README.md`, "Changes in 3.3"),
**off by default** with the fleet transport it reads through
(`docs/d2/fleet-transport.md`). It builds the "unreachable is a view" rule of
`docs/d2/part-two-design.md` (Detection times).

## What a calling agent may rely on

- `GET /v1/fleet/runs/{run_id}/view` (CLI: `agents runs show <run id>` for a run
  on another member) answers one of two things. `reachable`: the member's own
  answer in `run`, its true state. `unreachable`: no `run`, no state, and a
  `reason`. It never answers `succeeded`, or any state, for a member that did
  not answer.
- **It is computed on the caller on each read and never stored.** The calling
  core writes no state, event or file, and writes nothing on the member. Only the
  core that owns a run writes its terminal state `unknown`, with evidence that
  the worker is gone.
- **When.** A halted or partitioned member reads unreachable within 16 seconds of
  its last announcement (`not_listed`: trusted but not in the member list), or
  within 5 seconds of a failed call (`no_answer`). These are the stated
  numbers of the design record. Every caller sees it through its own core.
- **Healing.** A run read as unreachable can end in any terminal state. The first
  read after the member answers shows that state.
- A run read as unreachable does not say whether it was active: the caller keeps
  nothing about remote runs (`docs/d2/remote-runs.md`), so "every run that was
  active on the member" reads unreachable by reading every run of that member
  as unreachable.
- `agents runs show --json` of an answered remote run is the run, as before. Of
  an unreachable one it is the view (`"view": "unreachable"`, no `state`).
  `fleet.runs.show` is unchanged and answers `unavailable` while the member is
  silent.

## Tests

| Rule | Test |
| --- | --- |
| Every read of a run on a member that stopped answering is unreachable, 0 succeed | `core/test/fleet/unreachable.test.ts`, `core/test/fleet/unreachable-e2e.test.ts` (two real cores, the member halted with SIGSTOP), `tests/acceptance/d2/test_unreachable_runs.py` (two built cores, the real CLI) |
| Silence past the limit reads `not_listed` | `core/test/fleet/unreachable.test.ts` (injected clock) |
| The caller writes nothing; only the owner writes `unknown` | the same tests compare file digests of the caller's and the owner's directories before and after; the real-core test has the owner write `unknown` itself after SIGCONT |
| The true terminal state shows once the member answers | the same three tests |
| The shape | `contract/reachability.json` and its fixtures, `tests/test_contract_v3.py`, `core/test/contract/v3.test.ts` |
| The CLI text and JSON | `tests/test_cli_unreachable.py` |

## Not verified

- Two real hosts were run in task t28 (`docs/d2/part-two-acceptance.md`, check
  5): `no_answer` at 5.0 s and `not_listed` after the silence. The halt there was
  still SIGSTOP of the member's core, not of the network.
- A partition of the network itself, as against a halted process.
