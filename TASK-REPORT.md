# Task report: t25, the unreachable view

## What I built (contract 3.3, a MINOR addition: new route, new file)

- `contract/reachability.json` (root `RunView`) and fixtures. `contract/api.json` gains `fleet.runs.view`,
  `GET /v1/fleet/runs/{run_id}/view`. `api_version` is now 3.3 (api.json, version.json, README, the version
  fixtures, the generated types, `CLIENT_API_VERSION`). `contract/README.md` has "Changes in 3.3" and
  "The unreachable view (3.3)". The main agent merges this with t24 and t26's 3.3 additions.
- Core: `Unreached` (a `ControlError` subclass, `unavailable`) in `core/src/fleet/remote.ts`, thrown only when
  a trusted member is not in the member list (`not_listed`) or a call or address fails (`no_answer`).
  `fleetRunsView` in `core/src/daemon/fleet-routes.ts` does one GET and answers `reachable` with the member's
  run or `unreachable` with no state. Any other error is relayed as itself. Nothing is stored.
- CLI: `agents runs show <run id on another node>` reads the view. Answered: the same output and JSON as before
  (the run). Unreachable: text `state: unreachable (<reason>)` and JSON is the view, with no `state` key.
- `docs/d2/unreachable-view.md`; `docs/d2/remote-runs.md` points to it.

## Choices and assumptions

- The caller stores nothing about remote runs (t23), so it cannot know which runs were "active". I read the
  criterion as: every run id on a silent member reads unreachable, whatever its state. A finished run reads
  unreachable too until the member answers.
- A node that is not in the caller's trust list is not a member: the view route answers `unavailable`, as
  `show` does, not `unreachable`.
- `fleet.runs.show` is unchanged. I did not edit the five prompt files or CLAUDE.md. The "Not built" and
  "Current state" prose in them still names t25 as planned (left for the main agent's 3.3 merge).
- I moved `twoCores` out of `remote-e2e.test.ts` into `core/test/fleet/two-cores.ts` so both e2e tests share
  it. `remote-support.ts` got an optional `timing` for tests.

## Tests run

- `cd core && npm run build && npm test`: 849 tests, 837 passed, 0 failed, 12 skipped. `npm run lint`: 0 errors
  (clean after I removed an unused disable comment). `npm run typecheck` and `npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 2092 passed, 13 skipped, 1 failed.
  The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`.
  It builds a wheel, which needs the package registry. It also failed on the base tree
  (checked before my edits) and is unrelated to this task.
- black and flake8 on `culture_agents` and `tests`: clean. markdownlint, the SonarCloud rules and the scans
  were not run here.

Existing tests updated, none deleted: the 3.2 to 3.3 version assertions in `core/test/contract/v3.test.ts`,
`core/test/daemon/api.test.ts`, `core/test/fleet/remote-version.test.ts`, `core/test/fleet/remote.test.ts`,
`tests/test_cli_version_3.py`, `tests/test_contract_v3.py`, `tests/test_cli_runs.py`, `tests/test_cli_agents.py`,
`tests/test_cli_runs_unreadable.py`, `tests/test_cli_remote_runs.py`, `tests/acceptance/d1/test_mock.py`,
`tests/acceptance/d2/test_fleet_members.py`; route lists in `tests/test_contract.py`, `tests/test_contract_api.py`.

## Acceptance criteria

1. Every run on a silent member reads unreachable, 0 read succeeded: **proven** on loopback.
   `core/test/fleet/unreachable.test.ts` (three reads after the member stops, none carries a run;
   `not_listed` after the injected silence limit of 15 s). `core/test/fleet/unreachable-e2e.test.ts` and
   `tests/acceptance/d2/test_unreachable_runs.py` halt a real core with SIGSTOP and read through the HTTP route
   and the real CLI. The 16 s and 5 s bounds are **not measured on a real network**: the silence was an injected
   clock, and the call timeout was exercised by SIGSTOP (reads took under 12 s for two).
2. The caller writes nothing, only the owner writes `unknown`: **proven** for the caller's directory and the owner's
   run store, by file digests before and after (all three tests). In the e2e test the worker is killed while the
   owner is halted. The owner's store is unchanged across the caller's reads, and after SIGCONT the owning core
   writes `unknown` itself.
3. A run shown unreachable shows its true terminal state when its host answers: **proven**. The in-process test
   (the run ends on the member while cut off, then `succeeded`), the e2e test (`unknown`) and the Python
   acceptance test (`cancelled`).

## Not verified

- Two real hosts, a real network partition (t28). Markdownlint and SonarCloud.
- A mixed 3.2 and 3.3 fleet: the version rule was not run against a 3.2 core for the new route. A 3.2 member
  needs nothing new, because the view calls `fleet.runs.show`, which 3.2 serves.

## Reasoning lapse noticed

My first snapshot of the member's directory was taken before stopping it, so the member's own shutdown writes
failed the comparison. I took it after shutdown and said so in the test.
