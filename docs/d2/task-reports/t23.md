# TASK-REPORT t23: remote control calls (submit, steer, cancel and attach on another member)

## What I built

This task builds Decisions 4 and 5 of `docs/d2/part-two-design.md` as that
record recommends, on t21's transport and t22's member list. The contract is
now **3.2**, a MINOR addition on 3.1.

### Contract

- New file `contract/remote.json`:
  - the root `RemoteRun`, a run as another member sees it, with no
    repository path;
  - `$defs`: `alias`, `submit_request` (`agent_id`, `harness`, `alias`,
    `task`, `caller`, and optional `idempotency_key`, `deadline_ms` and
    `base_commit`), `submit_response`, `alias_list`, and `alias_file` (the
    local alias file, not an API payload).
- Six new routes in `api.json`: `fleet.runs.submit`, `fleet.runs.show`,
  `fleet.runs.attach`, `fleet.runs.steer`, `fleet.runs.cancel` and
  `fleet.aliases`.
  - Steer and cancel reuse the 3.0 `steer_request`, `cancel_request` and
    `accepted_response` shapes.
  - Attach reuses `event.json`.
- Fixtures: 9 valid and 11 invalid. Types are regenerated.
  `gen-contract-types.mjs` has names for the new types that would otherwise
  collide with existing ones.
- No 3.0 or 3.1 shape changed.
- `contract/README.md` has:
  - the version line;
  - a Files row;
  - the "Part two is not in 3.0" paragraph;
  - a new section "Changes in 3.2", with its table, "Remote runs (3.2)" and
    **"Calls between cores (3.2)"**, which states the version rule;
  - seven Routes rows;
  - a pointer from Versioning to the new rule;
  - one sentence in Authorization.
- Version 3.2 follows into `version.json`, the version fixtures,
  `CLIENT_API_VERSION` and the wheel's force-include list (`pyproject.toml`).

### The executing core: `core/src/fleet/serve-runs.ts` and `aliases.ts`

The fleet transport now serves an authenticated member these routes:

- `POST /v1/fleet/runs`
- `GET /v1/fleet/runs/{id}`
- `GET /v1/fleet/runs/{id}/events`
- `POST /v1/fleet/runs/{id}/steer`
- `POST /v1/fleet/runs/{id}/cancel`
- `GET /v1/fleet/aliases`

How a submit is checked, in this order:

1. The agent's node must be this core's node, otherwise `unsupported`
   `placement`. A core never forwards a submit.
2. The alias is resolved through the local, untracked `fleet/aliases.json`,
   otherwise `not_found`.
3. The allow-list check runs on the resolved path, unchanged, otherwise
   `denied`.
4. If `base_commit` is named, `git cat-file -e <sha>^{commit}` must find it,
   otherwise `invalid` with `field: /base_commit`. Nothing is fetched.

Then the run service is called:

- The submitter is `{kind: "member", node: <trust-list name>}`.
- The deadline is `now() + deadline_ms` on this core's clock.
- `RunService.submit` has a new optional third argument, `SubmitOptions`:
  - `baseRef`: the named commit;
  - `keyNamespace`: one namespace per member, so a member's key never meets
    another submitter's;
  - `digestOf`: the remote body, so a repeat matches although the absolute
    deadline differs.
- `runs/keys.ts` shows the key without its namespace in a `conflict`.

Other rules on the executing core:

- Show, events, steer and cancel are served only on a run whose submitter is
  the calling member; any other run is `denied`.
- The `Agents-Api-Version` header is required on these routes and checked
  first. The rule is the same MAJOR, any MINOR.
- On the 3.1 announce and member-list routes the header is checked only when
  present. The announcer now sends it.
- Request bodies are capped at 1 MiB, and the events page at 50 events.

### The calling core: `core/src/fleet/remote.ts`, `remote-attach.ts` and `core/src/daemon/fleet-routes.ts`

- The control socket has the six local routes. Each checks the request
  against its schema, then calls the member the request names:
  - the node of the agent id for a submit;
  - the node of the run id for show, attach, steer and cancel;
  - `?member=` for aliases.
- `createRemote` checks, before sending:
  1. The member is listed now, otherwise `unavailable`.
  2. Its announced MAJOR equals this core's, otherwise `incompatible_version`.
  3. Its announced MINOR is at least 3.2, otherwise `unsupported`
     `placement`, and nothing is sent.
  4. An address in `peers.json` last answered as that member's key, otherwise
     `unavailable`. The announcer keeps this list (`addressOf`).
- The call is `fleetCall` with `expectNode`, a 5 s timeout, a 1 MiB cap
  (8 MiB for an event page) and the version header. `fleetCall` gained a
  `headers` option.
- The answer is checked against its schema:
  - a typed error is relayed, prefixed with the member's name;
  - anything else is `internal`;
  - no answer is `unavailable`.
- Attach is an SSE stream on the control socket, fed by reading event pages
  from the member, 10 events per call. While nothing is new it asks again
  every 250 ms.
  - The first page is read before the stream starts, so a refusal is a JSON
    error.
  - Cursor gaps are checked.
  - The stream closes at the terminal event, or at once when the run is
    already terminal.
- With the transport off, the routes answer `unsupported` `placement`.
- Wiring: `createFleet` takes the run service, the allow-list and the clock,
  and exposes `fleet.remote`. `startDaemon` takes `remote`.
  - `main.ts` passes both. It is now 381 lines.
  - `FleetTiming.apiVersion` and `memberRoutes(..., reported)` let a test
    stand a core up that reports 3.1.
  - `isPeerCompatible` and `servesSince` are new in `contract/api.ts`.

### CLI

- `agents runs submit` has:
  - `--alias`; exactly one of `--repo` and `--alias` is required;
  - `--deadline-in <seconds>`, sent as `deadline_ms` for a remote run and
    turned into the absolute deadline for a local one;
  - `--base <sha>`;
  - `--no-base`.
- With `--alias`, the CLI sends `POST /v1/fleet/runs`. The base commit
  defaults to the HEAD of the git checkout the CLI runs in, which is the
  recommended answer to question 9. That helper is in the new
  `culture_agents/cli/_remote.py`.
- `CoreClient.run_route` sends `runs show|attach|steer|cancel` to
  `/v1/fleet/runs/...` when the run id's node is not the core's node. The
  attach reconnect loop in `_stream.py` follows the same route.
- New verb: `agents agents aliases --member <node>`, with its explain entry.
  The runs and submit explain pages describe remote runs.

### Docs

- New: `docs/d2/remote-runs.md`. It includes the rule-to-test table and what
  is NOT VERIFIED.
- Updated:
  - `docs/d2/fleet-transport.md`: status and routes;
  - `docs/d2/fleet-members.md`: status line;
  - `core/README.md`;
  - in each of the five prompt files: the transport paragraph (remote runs
    exist on the transport, off by default), the API version line (3.2) and
    the verb list (`list|status|aliases`).
- The key's `/proc/<pid>/environ` residue is restated in
  `docs/d2/remote-runs.md`. Key handling did not change.

## Tests run (final state, after the last code commit)

- `cd core && npm test` (builds first): **826 tests, 814 passed, 0 failed,
  12 skipped.**
  - 11 of them are new: `core/test/fleet/remote.test.ts` (7),
    `remote-version.test.ts` (3) and `remote-e2e.test.ts` (1).
- `npm run lint`, `npm run typecheck` and `npm run check:contract-types`:
  all exit 0.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` from the
  repository root, run after the core build and before the last commit:
  **1991 passed, 1 failed, 13 skipped.**
  - The last commit changed only TypeScript tests, so this run still covers
    the Python side.
  - The failure is
    `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`.
    `uv build` cannot fetch hatchling from pypi.org ("client error
    (Connect)"), because this sandbox has no registry. t21 and t22 reported
    the same failure.
  - New Python tests: `tests/test_cli_remote_runs.py` (13) and
    `tests/acceptance/d2/test_remote_runs.py` (2, two built cores and the
    real CLI).
- black, isort, flake8 (`-j1`) and bandit (`-c pyproject.toml -r
  culture_agents`): all exit 0.
- `python3 scripts/check-file-length.py`, `scripts/check-example-node.py` and
  `scripts/scan-secrets.py`: all clean.
- **Not run:**
  - markdownlint-cli2, which is not installed here;
  - `teken cli doctor . --strict`, which fails to start here ("cannot invoke
    'agents'", because the tool is not installed into its environment);
  - `harness-smoke.py`;
  - the live acceptance stages.
- **Checked by hand, not by a tool:**
  - cognitive complexity of the new functions (the eslint config has no
    complexity rule);
  - no nested ternary, no `void`, no nested template literal;
  - no `await` in a loop except `streamRemoteAttach`, whose exits depend on
    each page.

## Acceptance criteria

1. **Proven.** A submit from one core runs on another and is steered,
   cancelled and attached from the caller, and the run's submitter is the
   authenticated member.
   - `core/test/fleet/remote.test.ts`, "a submit from the calling core runs
     on thor and is shown, attached, steered and cancelled from the caller":
     two in-process cores over the real transport.
   - `core/test/fleet/remote-e2e.test.ts`: two real core processes, each the
     real `main` with the transport on, the real store and a real worker. The
     run is attached, steered and cancelled from the caller. Thor's store
     records `submitter: {kind: member, node: <caller>}`, and the attach
     stream ends at `cancelled`.
   - `tests/acceptance/d2/test_remote_runs.py`: two built cores, the real CLI
     on the caller and the stub harness. The steer from the caller changes
     the files on thor's `runs/<id>` branch. A second run is cancelled from
     the caller.
2. **Proven.** A deadline is sent as a duration and evaluated on the
   executing core's clock. With the two clocks an hour apart, the run gets the
   same length.
   - `core/test/fleet/remote.test.ts`, "the deadline crosses as a
     duration…": thor's injected clock is set 1 hour behind the caller's real
     clock, then 1 hour ahead.
   - Both times, the recorded deadline minus thor's acceptance time is the
     90 000 ms sent, and deadline minus `created_at` is 90 000 ms.
   - The remote submit schema refuses an absolute `deadline`.
   - The worker's enforcement on its own clock is part one's, and this task
     did not change it.
3. **Proven.** Two cores on different minor versions of API major 3 call each
   other in both directions, and the rule is in `contract/README.md`, under
   "Calls between cores (3.2)".
   - `core/test/fleet/remote-version.test.ts`: thor reports 3.1 (version
     route, announcements, header), and the caller is 3.2.
   - 3.2 to 3.1: the announcement is accepted, and the caller reads thor's
     version and member list (200), a pairing the client rule would refuse. A
     remote submit to thor is refused on the caller as `unsupported`, naming
     both versions, and nothing reaches thor.
   - 3.1 to 3.2: thor announces, reads the caller's version and member list,
     and the 3.2 core serves its 3.2 routes to a 3.1 header.
   - A core reporting 4.0 is never listed and gets 412 `incompatible_version`
     in both directions.
4. **Proven.** The repository is named as the executing host knows it: an
   alias that host defines, resolved to an allow-listed path (Decision 4).
   - `core/test/fleet/remote.test.ts`, "the repository is an alias thor
     defines…":
     - a `repo` path in the request is `invalid`;
     - an unknown alias is `not_found`;
     - an alias whose path the allow-list does not permit is `denied`, and
       nothing reaches the service;
     - `agents agents aliases` reports aliases and permits, never a path.
   - "a named base commit…": a missing commit is `invalid` on
     `/base_commit`, a present one becomes the run's base, and none means
     thor's HEAD (Decision 5).
   - `tests/acceptance/d2/test_remote_runs.py`: the CLI's default base (this
     checkout's HEAD) is refused by thor's fresh repository.

Also tested:

- authority (another member is `denied` on show, events, steer and cancel,
  and thor's operator cancels the run locally);
- a stopped member is `unavailable` in under 6 s;
- an unlisted member is `unavailable`;
- a core with the transport off answers `unsupported`;
- the alias file refuses a duplicate alias and a relative path.

## Choices and assumptions (read these)

- **API 3.2, with one new file.** All new routes share `remote.json`. The
  remote submit and show have their own shapes, because the 3.0 `run` and
  `submit_request` carry an absolute `repo` path. The record says paths stay
  private to each host, and changing an existing shape would be MAJOR.
- **Choosing the member.** The node of `--agent`, and later of the run id,
  names the member. There is no separate `--member` flag on `runs submit`,
  because the agent id already names its host. The plan names `runs.py`
  "for choosing a member", and this is how it chooses.
- **Same paths on both hops.** The local routes and the transport routes use
  the same `/v1/fleet/runs…` paths and shapes.
  - The events route exists only on the transport, where attach uses it.
    There is no local `fleet.runs.logs`. Remote `logs` and `result` are t26.
  - Reads of a remote run are limited to the submitting member, the
    recommended answer to question 8. t26 may revisit this.
- **Errors.**
  - A member that announced less than 3.2 gets `unsupported` with capability
    `placement`, because the contract has no closer capability name.
  - A run on another member that a member did not submit is `denied`, not
    `not_found`. Run ids carry 80 random bits.
- **No setting widens what a member may do.** The instruction says "unless
  the operator allows more (none by default)". I built the default only and
  added no setting.
- **Steer and cancel keys are not namespaced per member.** They are already
  scoped by run, and only the submitting member and the local operator can
  act on the run. A member and the local operator reusing one key on one run
  would collide.
- **Admission.** A remote submit passes through the run service's normal
  limit and admission steps, so an unknown signal gives a warning, as for a
  local submit. Refusing it is t24.
  - `admission_held` is in `fleet.runs.submit`'s error list, and
    `tests/test_contract_part_two_ready.py` was updated to allow it on the two
    submit routes.
- **Timeouts.** The remote submit is bounded by the transport's 5 s
  per-call timeout on both sides. A slower worker start answers `unavailable`,
  and the CLI's keyed retry then replays the first run.
- **The 3.1 core in the test** is this build reporting 3.1. A real 3.1 core
  serves only version, announce and the member list, which is all a 3.2
  caller sends it.
- **Test-first only in part.** I wrote the contract first, then the
  implementation, then the tests in the next commits. The tests were not
  committed failing before the code.
- **Node names in tests.** Thor is the executing core. The caller and a
  third member use the length-boundary filler `xxxxxxxx` and `yyyyyyyy`,
  as t22 did. Two members cannot share a name (c40).
- `test/runs/child.ts` takes `TEST_NODE`, so a second real core can have
  another name.

## Existing tests updated (none deleted)

- These now expect 3.2:
  - `core/test/contract/v3.test.ts`, which also asserts that a 3.1 client is
    accepted and a 3.2 client refuses a 3.1 core;
  - `core/test/daemon/api.test.ts`;
  - `tests/test_contract_v3.py`, where the test was renamed `…_3_2`;
  - `tests/test_cli_version_3.py`;
  - `tests/test_cli_runs.py`, where the incompatible-core cases gained 3.1;
  - `tests/test_cli_agents.py`;
  - `tests/acceptance/d1/test_mock.py`, where the test was renamed `…_3_2_core`;
  - `tests/acceptance/d2/test_fleet_members.py`.
- `tests/test_contract_api.py` lists the six new routes.
- `tests/test_contract.py` lists `remote.json`.
- `tests/test_contract_part_two_ready.py`: see admission above.
- `tests/fake_core.py` serves the new routes.

## Left unchanged on purpose

- Every 3.0 and 3.1 schema, `transport.ts` (apart from the `headers` option),
  `trust.ts`, `cert.ts`, `peers.ts` and `members.ts` (apart from the
  reportable version).
- The worker's deadline enforcement.
- `CHANGELOG.md` and the package versions, which are left to the merge, as in
  t21 and t22.
- The "Not built: D2 part two (… placement …)" sentence in the prompt files.
  A scheduler that places runs is still not built; remote runs are described
  in the transport paragraph.
- `spikes/`, which nothing imports, `.claude/skills`, `.devague` and
  `docs/d2/part-two-design.md`.
- `.gitignore`. I excluded the `core/node_modules` symlink locally in
  `.git/info/exclude`, not in a tracked file, and removed the symlink before
  finishing. No commit contains it.

## Not measured

- Two real hosts, real clock drift, a real 3.1 core, and the Claude Code and
  OpenCode harnesses on a remote run. These are left to t28 (see
  `docs/d2/remote-runs.md`).
