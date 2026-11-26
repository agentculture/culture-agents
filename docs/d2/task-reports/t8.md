# Task report: t8, concurrent runs in one repository with operator-configured limits

Plan `d2-fleet-and-recovery`, task t8 (covers c4, h4, c5, h5, c53, h51).

## What I built

- **No implicit limit, `busy` removed.** Step 7 of the submit order was "the
  repository already has an active run → `busy`". It is now the limit check,
  `checkLimits` in the new `core/src/runs/limits.ts`.
  - With no limit configured the check reads nothing and refuses nothing.
  - With a limit configured, a submit past it gets `limit_reached`, with
    `limit: {name, value, active[, repo]}` and a message that names the limit
    and its value. Nothing is queued and no run directory is created.
  - `runs_per_repository` is checked before `runs_per_host`.
  - A run counts as active when its state is active, including a run whose
    worker survived a restart.
  - A run that cannot be read but whose worker may be alive also counts. It
    counts against every repository when its record cannot be read either.
  - `service.ts` changed by a few lines and is now 373 lines. The submit chain
    stays, so the check and the spawn are still one step.
- **Limits come from the core's config file only.** The new
  `core/src/daemon/limits.ts` `loadLimits(env)` reads `limits.runsPerRepository`
  and `limits.runsPerHost` from the harness config file:
  `$XDG_CONFIG_HOME/culture-agents/harness.json`, or the file named by
  `CULTURE_AGENTS_HARNESS_CONFIG`.
  - `config.ts` now exports `configPath` and `readConfigFile` so both readers
    use the same file.
  - A value must be a whole number of at least 1, or null for no limit. Any
    other value or any unknown key stops the core at start with exit 2
    (`main.ts`, new `MainOptions.limits`).
  - The environment cannot set a limit, and neither can a request: the request
    schema is closed.
  - `runs/` does not import harness code: `NO_LIMITS` lives in
    `runs/limits.ts`.
- **`worktree_isolation`** is now reported as supported by every harness. Its
  caveat states the guarantee: "a sandbox clone per run, not a host worktree".
  The text is in `SANDBOX_ISOLATION` in `harness/common/capabilities.ts`. The
  stub has no sandbox, so it reports its own caveat (`STUB_ISOLATION`): a
  temporary host clone, never a worktree.
- **Contract**:
  - `error.json` no longer has `busy`, its `active_run_id` and `repo`
    properties, or the busy if/then. `api.json` drops `errors.busy` and `busy`
    from `runs.submit`.
  - `contract/README.md`: the changes table has a row for the removal; the
    `limit_reached`, `worktree_isolation` and `reconnect` rows are marked
    built; step 7 is rewritten; the busy rule is replaced by "Concurrent
    runs"; the busy row is gone from the errors table; the config keys are
    documented under Limits.
  - I regenerated `core/src/contract/generated/error.ts`.
- **Fixtures**:
  - Removed: `valid/error/root.busy`, `invalid/error/root.const-busy-not-retryable`
    and `invalid/error/root.required-busy-without-active-run`.
  - Renamed: `invalid/error/root.not-limit-on-busy` is now `…not-limit-on-conflict`,
    and `invalid/event/…refused-with-busy-code` is now `…refused-with-limit-reached-code`.
    The second one would otherwise fail for two reasons now that `busy` is no
    longer a code.
  - Added: `invalid/error/root.enum-busy-code-removed` and
    `root.additionalProperties-active-run-id-removed`.
  - In 20 capability documents across the fixtures, `worktree_isolation` is now
    supported with the guarantee text.
- **CLI and explain text**:
  - `_client.py` no longer maps `busy` or gives a hint for it.
  - The explain catalog, `learn` and the docstrings name `limit_reached`
    instead.
  - The `runs submit` explain text says that runs are concurrent and that
    there is no implicit limit.
- **Concurrent-fetch check (parked item):** `docs/d2/concurrent-fetch.md`
  records it, and a test covers it (see criterion 3). The result: simultaneous
  fetches into one repository with packed refs all succeed. Each fetch locks
  only its own `runs/<id>` ref, and a ref update never rewrites `packed-refs`.
- `CLAUDE.md`: "busy refusal" became "configured limits" in the module list.

## Commands and final counts

- `cd core && npm test` (build + all tests): 625 tests, 613 pass, 0 fail, 12
  skipped. The 12 skips are the suite's own opt-ins; I added no skips.
- `npm run lint`, `npm run typecheck`, `npm run check:contract-types`: all
  clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (repo root,
  after the core build): 1601 passed, 1 failed, 9 skipped.
  - The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`:
    `uv build` fails with "tcp connect error" because this sandbox has no
    network. The t6 and t7 reports record the same failure.
  - The 9 skips are the opt-in live stage (NOT VERIFIED) and the check that
    needs a sibling `culture` checkout.
- The new and changed run tests (`concurrent`, `isolation`, `restart`,
  `unreadable`) were run 3 more times: 14/14 pass each time.
- `python3 scripts/check-file-length.py`, `scripts/scan-secrets.py` and
  `scripts/check-example-node.py`: all clean.
- `black --check`, `isort --check-only`, `flake8 -j1` and `bandit -c
  pyproject.toml -r culture_agents`: clean. `black` reformatted one test file
  (`tests/test_cli_runs.py`) before the check.
- **Not run:** markdownlint (not installed here), `teken cli doctor`, and
  `harness-smoke.py`.

## Acceptance criteria

1. **Proven.**
   - `core/test/runs/concurrent.test.ts`, "with no limit configured, 3 submits
     to 1 repository are all accepted and each is steered independently". It
     submits 3 runs, steers each with its own message and checks that each
     log holds only its own steer. It then cancels one and checks that the
     other two keep running.
   - `busy` is gone from the code, contract and explain text:
     `tests/test_contract_v3.py::test_the_busy_refusal_is_gone_now_that_concurrent_runs_are_built`
     checks the schemas, routes and README;
     `tests/test_contract_api.py::test_error_table_matches_error_schema_and_exit_codes`
     asserts `busy` is not a code; `grep busy` over `core/src`,
     `culture_agents` and `contract/*.json` finds only unrelated identifiers
     (a socket set in `worker/control.ts`, an OpenCode time field).
   - D1 acceptance (`tests/acceptance/d1/test_mock.py`): a second run in one
     repository is now accepted through the real CLI and core.
2. **Proven.**
   - `concurrent.test.ts`, "a per-repository limit refuses…":
     `runsPerRepository: 2` is written to the core's config file; the third
     submit gets `limit_reached` with
     `{name: runs_per_repository, value: 2, active: 2, repo}`, and the message
     names the limit and the value. There are still exactly 2 run directories.
     Another repository still has room, and the repository has room again
     after a run ends.
   - "a per-host limit refuses…" does the same with `runs_per_host`.
   - "a limit cannot come from a request" shows that a request carrying
     `limits` is `invalid`.
   - Config parsing is covered by `core/test/daemon/limits.test.ts`, including
     a daemon that refuses to start on `runsPerHost: 0`.
3. **Proven.**
   - `core/test/runs/isolation.test.ts`, "2 runs in 1 repository complete…".
     Two real stub-harness runs (worker, temp clone, commit, collect) are
     submitted together into one repository that has a tracked file and an
     untracked file, and both reach `succeeded`. Each `runs/<id>` holds
     exactly the commits its result reports, the two sets do not overlap, and
     each tree holds only its own files.
   - The checkout files, `.git/index`, `HEAD`, `config` and `main` are
     byte-identical before and after.
   - `git worktree list` shows only the main checkout, and `.git/worktrees`
     does not exist.
   - The second test in that file is the concurrent-fetch check: 6 workspaces
     × 6 rounds of simultaneous `collect()`, with packed refs.
   - Not run: the sandbox path with a real OpenShell gateway (none here). That
     path's fetch uses the same refspec.
4. **Proven.** `core/test/harness/registry.test.ts`, "every harness … validates"
   asserts that `worktree_isolation` is supported for claude-code, opencode
   and stub. The caveat must say "sandbox clone per run, not a host worktree"
   (stub: "own temporary clone"), the `runs/<run_id> branch`, "no git worktree
   is created" and "host checkout and index are never written".

## Choices and assumptions

- **Where the limits live:** in the existing harness config file, under
  `limits`, with camelCase keys like the file's other keys. They are set in
  the file only, with no environment variable, because the plan says "from
  the core's config file". The file is read once at start, as the harness
  config is.
- **Order:** the repository limit is checked before the host limit.
- **Unreadable runs:** with no limit configured they no longer block anything.
  This matches the spec: "never keeps a repository busy for ever". With a
  limit configured they count as active, to be conservative.
- **`limits` in capability documents** (the "number a caller can read") is
  t17's field. I did not add it to the documents. Today the caller reads the
  limit and its value in the `limit_reached` refusal, and in the config file.
- **The t4 extra item** (showing unreadable runs over the API): the 3.0
  contract has no shape for an unreadable run in a listing, so I did not
  change it. Such runs are still skipped by listing.
- `harness-catalog.ts` is unchanged. The limits did not need the catalog port:
  `main.ts` loads them and passes them to the run service.

## Tests updated (none deleted)

- `core/test/runs/control.test.ts`: the first test now expects a second run in
  the same repository to be accepted.
- `core/test/runs/restart.test.ts`:
  - a surviving worker now counts against a configured `runsPerRepository: 1`
    (it used to hold `busy`);
  - "before the busy check" became "before the limit check", with the same
    limit.
- `core/test/runs/unreadable.test.ts`:
  - the corrupt-log test now asserts `limit_reached` under a configured limit;
  - new test: with no limit, the repository still takes a submit;
  - the liveness test lost its one `internal`-on-submit assertion, because
    with no limit configured a submit no longer reads other runs.
- `core/test/daemon/api.test.ts`: the fake service's refusal is now
  `limit_reached`.
- `core/test/contract/helpers.test.ts`: the `busy` row is gone from the codes
  table.
- `core/test/harness/registry.test.ts` and `contract-suite.ts`:
  `worktree_isolation` is no longer undeclared, so the count dropped from 7 to
  6.
- `core/test/runs/child.ts` and `support.ts`:
  - a `stub: true` fake harness runs the real stub driver;
  - new `writeLimits` helper;
  - the fake documents report `worktree_isolation` as supported.
- `tests/test_cli_runs.py`, `tests/test_contract_api.py`,
  `tests/test_contract_v3.py` and `tests/acceptance/d1/test_mock.py`: as
  described under criterion 1.

## Test-first

I wrote the new tests (`concurrent`, `isolation`, `daemon/limits`) before the
implementation. At first they failed to build, because the limits module did
not exist. After I implemented it they passed on the first run. I did not run
them against the old busy code at runtime. Against it, the 3-submit and
isolation tests would get `busy` on their second submit, because `ok()`
asserts 201.

## Left unchanged on purpose

- `docs/d0/d1-acceptance.md` (the historical D1 record that mentions `busy`),
  `docs/specs`, `docs/plans` and the earlier task reports.
- `CHANGELOG.md`: no earlier D2 task added an entry.
- `core/src/daemon/harness-catalog.ts`, `core/src/sandbox/worktree.ts` and the
  idempotency path.
- `.claude/skills`, `.devague` and `spikes`.
- No new dependency. The `core/node_modules` symlink was removed and is not
  committed.
