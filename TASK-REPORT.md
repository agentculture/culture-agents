# TASK-REPORT t32: show run directories the core cannot read over the API

## What was built
- **Contract 3.2** (MINOR): new route `runs.unreadable`, `GET /v1/runs/unreadable`, new schema
  `contract/unreadable.json` (`UnreadableRunList`: `count`, `runs[{run_id, reason, detail}]`;
  `reason` is `newer_version | corrupt_record | unreadable_log | other`), valid and invalid
  fixtures in `contract/fixtures/{valid,invalid}/unreadable/`, README section "Changes in 3.2"
  and change-table row, generated types. No existing shape changed. `api_version` is 3.2 (it was 3.1
  on this branch when I started); the CLI client version, the `version` fixture and tests moved to 3.2.
- **Core**: `core/src/runs/unreadable.ts` (`listUnreadableRuns`), `RunService.listUnreadable`,
  `StoreRunService` implementation, route in `core/src/daemon/routes.ts` (placed before
  `runs.show` so `unreadable` is not taken as a run id).
- **CLI**: `agents runs unreadable` (new verb); `agents runs list` calls the route and prints one
  line `warning: N run(s) could not be read; list them with: agents runs unreadable` when N > 0;
  `--json` carries `unreadable_count` (always, 0 included) beside `runs`, as the CLI's own field.
  Text from a run directory goes through `visible` (`_val`). Explain catalog, `_contract.py`,
  `pyproject.toml` wheel manifest and the agent docs (version 3.2, gap line in CLAUDE.md) updated.

## Tests run (exact)
- `cd core && npm run build && npm test`: 792 pass, 0 fail, 12 skipped. `npm run lint`,
  `npm run typecheck`, `npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` : 1918 passed, 13 skipped, **1 failed**:
  `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`. Cause:
  `uv build` cannot resolve `build-system.requires` (no network). Not caused by this change; I did
  not run it on a clean checkout to compare.
- `teken cli doctor . --strict` (with a temporary `agents` shim on PATH, outside the repo): 25/26 pass;
  the one failure is `main_entry_contract`, which builds the package and fails to download
  `pathspec` (no network).
- ruff is not installed here: lint/format of the Python files was NOT run; I kept lines at most
  100 columns by hand (awk check) and files under 400 lines.

## Acceptance criteria
1. **Proven.** `core/test/runs/unreadable.test.ts` (corrupt record, corrupt log, newer version, a
   non-version `store.json` as `other`, validated against the schema; route test over the socket);
   fixtures checked by `core/test/contract/fixtures.test.ts` and `tests/test_contract.py`;
   `tests/test_contract_api.py` (route listed), `tests/test_contract_v3.py`.
2. **Proven.** `tests/acceptance/d2/test_unreadable_runs.py` drives the real CLI against the real core
   with a corrupt-log run and a newer-version run: one warning line, `unreadable_count` 2,
   `runs unreadable` names both with their reasons. Fake-core tests in
   `tests/test_cli_runs_unreadable.py` (singular/plural, no warning at 0, escaping).
3. **Proven.** `unreadable.test.ts` compares bytes, size, mtime and ctime of the three kinds of
   directory (a newer one with a `summary.json`) before and after listing; the acceptance test does
   the same through the CLI. The existing unreadable-run tests (`core/test/store/versioned.test.ts`
   etc.) pass unchanged.

## Choices and assumptions
- `run_id` is always the directory name: only directories named as a run id are listed (the store's
  own listing ignores other names), so the schema has no null run id. A directory that is not named
  as a run id is not reported.
- A finished run whose record is corrupt but whose summary still matches its log is *readable*
  (the summary is trusted by design), so the acceptance test corrupts the event log instead.
- The listing says nothing about live workers; `reason` is decided by re-reading the version file,
  record and log in that order.
- Existing tests updated, none deleted: version strings 3.1 to 3.2 (`core/test/daemon/api.test.ts`,
  `core/test/contract/v3.test.ts`, `tests/test_cli_*.py`, `tests/test_contract_v3.py`,
  `tests/acceptance/d1/test_mock.py`, `tests/acceptance/d2/test_fleet_members.py`); `runs list --json`
  expectations gained `unreadable_count` (`tests/test_cli_runs.py`, `tests/acceptance/d1/test_mock.py`);
  `tests/fake_core.py` has a default for the new route; `tests/test_contract.py` lists the new schema.
- t23 also edits `routes.ts`, `api.json` and the README: if it also bumps to 3.2, the merge needs
  one of the two to take 3.3.

## Left unchanged on purpose
`core/src/runs/scan.ts` (`unreadableLiveRuns` still serves limits), `core/src/store/*`, the existing
`run_list` shape.
