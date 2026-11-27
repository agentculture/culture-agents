# Task report: t30 (contract 3.0 ready for part two)

## What I built

This change touches schemas and documents only. The core behaves as before: every harness still
reports `placement` as unsupported, and no route returns the new refusal.

- `contract/capabilities.json`: `capability_set.placement` now uses the supportable `capability`
  shape, as `answer`, `reconnect` and `worktree_isolation` do. The `deferred` description no longer
  names placement.
- `contract/error.json`: one new code, `admission_held`. It must carry a `signal` of the new
  `$defs/held_signal` shape: `name` (a `capabilities.json` `signal_name`, so `heat` or `gateway`),
  `state` (`hold` or `unknown`) and `observed_at` (a nullable timestamp, null when there is no
  reading). With this code `retryable` must be true and `signal` must be present; with any other
  code `signal` is forbidden. This follows the pattern of `limit_reached` and its `limit`.
- `contract/api.json`: an error-table row `admission_held` (HTTP 429, exit 1, retryable true), and
  the code added to the `runs.submit` error list.
- `contract/control-action.json`: the prose of `submit_request` now says placement is refused
  "until part two builds it (planned)". This is a description change only.
- `contract/README.md`: I rewrote the paragraph "Part two is not in 3.0". Both items are now shapes
  in 3.0, marked **(planned, part two)**, and the paragraph says "Part two can then add both as
  behaviour inside 3.0, without a MAJOR bump". I also:
  - added two rows to the Changes table;
  - added a planned check to the `runs.submit` order of checks (after the limits);
  - moved `placement` from the Deferred table to "Capabilities that 3.0 allows" ("these four");
  - added a planned paragraph to "Limits, load and admission";
  - added an error-table row;
  - added `held_signal` to the Files table.
- Fixtures:
  - valid: `capabilities/root.placement-supported-with-caveat`,
    `error/root.admission-held-heat` (hold, with a time) and
    `error/root.admission-held-gateway-unknown` (unknown, `observed_at` null);
  - invalid: `capabilities/root.type-placement-unsupported-without-reason`,
    `error/root.required-admission-held-without-signal`,
    `error/root.const-admission-held-not-retryable`,
    `error/root.enum-held-signal-name-unknown`,
    `error/root.enum-held-signal-state-admit`,
    `error/root.required-held-signal-without-observed-at`,
    `error/root.not-signal-on-limit-reached`.
- Generated types: I regenerated them with `npm run gen:contract`. They add the
  `ErrorCode` value, `ErrorBody.signal`, `HeldSignal`, and `placement: Capability`.
- `core/src/harness/common/capabilities.ts`: the `Deferred` type no longer fits `placement`, so
  placement is now built with `unsupported(...)`. The reason text is now "This core runs work only
  on its own node; placement on another node is not built yet (planned, D2 part two)." The value is
  still `supported: false`, so the behaviour is the same.
- CLI: `culture_agents/cli/_client.py` maps `admission_held` to exit 1 and gives it a hint. The hint
  says nothing was queued, and the caller can retry later or submit to another host that admits it.
  The code is not in the keyed-retry path, which retries only `unavailable`. I also updated a
  docstring in `_errors.py` to name `signal` among the detail fields.

## Tests

New:

- `tests/test_contract_part_two_ready.py` (Python, 18 tests): the schema shape, both validators
  (the test validator and the CLI's `_contract.problem`) on every new fixture, the api.json row and
  route, and the README.
- `core/test/contract/part-two-ready.test.ts` (core, 4 tests): the core validator, the generated
  `HeldSignal` type, and the error table.

Existing tests I updated (none deleted):

- `tests/test_contract_api.py`: `placement` moved from `DEFERRED_CAPABILITIES` to
  `SUPPORTABLE_SINCE_3_0`.
- `tests/test_contract_v3.py`: `placement` moved from the deferred loop to the capability loop.
- `tests/test_cli_version_3.py`: two new parametrize rows in
  `test_the_new_typed_errors_map_to_their_exit_codes`, and a new
  `test_a_held_submit_is_exit_1_names_the_signal_and_hints_to_wait_or_go_elsewhere`. It checks
  exit 1, the signal named in the text, the hint, the JSON `signal`, and that the submit is not
  retried.
- `core/test/contract/v3.test.ts`: `placement` removed from the "pinned to unsupported" loop.
- `core/test/contract/helpers.test.ts`: `admission_held: [429, 1, true]` added to the error table.
- `core/test/harness/registry.test.ts`: still asserts that every harness reports placement
  unsupported, and now also asserts it has a non-empty reason.

## Commands run and results

- `ln -s /usr/local/share/dogfood/core/node_modules core/node_modules` (I removed it before
  finishing).
- `cd core && npm run gen:contract`: the types were regenerated.
- `npm run build`, then `npm run typecheck` and `npm run lint`: both clean.
- `npm run check:contract-types`: clean.
- `npm test`: 674 tests, **662 pass, 0 fail, 12 skipped**. The skipped tests are the opt-in live
  ones, the same set as before this change.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (from the repository root, after the
  core build): **1755 passed, 1 failed, 13 skipped**.
  - The one failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`.
    `uv build --wheel` cannot download `hatchling` because this sandbox has no package registry
    (`tcp connect error ... Permission denied`). The cause is the environment, not this change.
    The wheel check itself was **not run**.
  - The 13 skipped are the live and NOT VERIFIED acceptance stages, plus a test that needs a sibling
    checkout of `culture`.
- `black --check culture_agents tests`, `isort --check-only culture_agents tests` and
  `flake8 -j1 culture_agents tests`: all clean.
- `python3 scripts/check-example-node.py`, `scripts/scan-secrets.py` and
  `scripts/check-file-length.py`: all clean.
- **Not run:**
  - `markdownlint-cli2`: not installed in this sandbox.
  - `bandit`.
  - `teken cli doctor`.
  - `harness-smoke.py`.

## Acceptance criteria

1. **Proven.** The capabilities schema accepts a report with placement supported and a caveat, and
   every harness still reports it unsupported with a reason:
   - the valid and invalid fixtures pass in both the core and Python fixture loops;
   - `test_a_report_with_placement_supported_and_a_caveat_validates`,
     `test_placement_unsupported_still_needs_a_reason` and
     `test_placement_uses_the_supportable_capability_shape` (Python);
   - "a capability report may state placement as supported with a caveat" (core);
   - `core/test/harness/registry.test.ts` checks every real harness, available and unavailable,
     for `supported: false` and a non-empty reason.
2. **Proven.** `error.json` has exactly one new code, `admission_held`. It names the signal (`heat`
   or `gateway`), carries its state and observed time, and is retryable:
   - `test_admission_held_is_one_new_retryable_user_error_on_submit`,
     `test_the_held_signal_names_the_signal_its_state_and_its_observed_time`,
     `test_valid_held_refusals_pass_both_validators` and
     `test_invalid_held_refusals_are_rejected_by_both_validators`. These cover the test validator
     and the CLI's `_contract.problem`;
   - the core's `part-two-ready.test.ts` and `fixtures.test.ts` cover the core validator.
3. **Proven.**
   - `test_readme_no_longer_leaves_placement_and_held_submits_undecided`,
     `test_readme_moves_placement_out_of_the_deferred_table` and
     `test_readme_error_table_has_the_held_refusal` cover the README.
   - The CLI exit code and hint are covered by `tests/test_cli_version_3.py` (the parametrize rows
     and `test_a_held_submit_is_exit_1_names_the_signal_and_hints_to_wait_or_go_elsewhere`).

## Choices and assumptions

- **Name and placement of the code:** `admission_held`, with the field `signal` as an object
  `{name, state, observed_at}`. This mirrors `limit_reached` and its `{name, value, active}`.
- **HTTP 429, exit 1:** the same as `limit_reached`. Like a limit, a hold is the target host's
  current state, not a broken environment on the caller's side: the caller can wait or choose
  another host. `test_contract_api.py` reserves exit 2 for `incompatible_version`, `unavailable` and
  `internal`.
- **`state` is `hold` or `unknown`, never `admit`:** an admitting signal cannot hold a submit.
  `unknown` is included because the owner's decision of 2026-11-26 is that an unknown signal
  refuses a remote submit.
- **No optional `reason` on `held_signal`:** `message` carries the explanation. The criterion asks
  only for the signal, its state and its observed time, and an optional field could be added later
  only as a MAJOR change. If part two wants a reason, it should be added now instead.
- **`admission_held` is in the `runs.submit` error list of `api.json` already,** so part two does
  not have to change the route table. The README marks it as planned, and no core code produces it.

## Left unchanged on purpose

- `core/src/runs/admission.ts`: t31 owns it.
- `core/src/runs/service.ts`: it still refuses another node with `unsupported`, `placement`.
- The text lists of refusal codes in `culture_agents/cli/_commands/learn.py`,
  `culture_agents/explain/catalog.py` and `catalog_control.py`: no route returns the new code yet,
  and this task is limited to the exit code and hint.
- `core/test/runs/child.ts`, `core/test/runs/reattach.test.ts` and
  `core/test/store/retention.test.ts`: their fake capability documents still type-check, and their
  placement value is still unsupported.
- `CLAUDE.md`, `AGENTS*.md`, `CHANGELOG.md` and the package version: no bump or changelog entry,
  which I leave to the main agent.
- `docs/d2/part-one.md`.
