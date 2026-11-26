# TASK-REPORT t18: D2 part one acceptance suite and record

## Built

- `tests/acceptance/d2/` (`__init__.py`, `conftest.py`, `test_mock.py`, `test_live.py`). It reuses the D1 `Core` harness (`tests/acceptance/d1/support.py`).
  - Mock stage (always runs; real CLI, real core, stub harness): 5 success-signal checks plus the timing check.
    1. Restart with 2 runs in 1 repository, then steer one and cancel the other.
    2. One idempotency key sent 2 times gives 1 run; a changed request gives `conflict`.
    3. A question survives a SIGKILL restart and is answered with `runs answer`; a second answer gets `conflict`.
    4. `limits.runsPerRepository: 2` in the config file refuses a third submit with `limit_reached`.
    5. A killed worker reads `unknown`; every `succeeded` run has the worker's `succeeded` event.
    6. With 2 runs in 1 repository, the third submit to another repository returns in 0.33 s and a cancel reaches `cancelled` in 0.33 s.
  - Live stage (opt-in, `CULTURE_AGENTS_ACCEPTANCE_LIVE=1`): timing check for both harnesses, with no hard time limit on a model turn. A harness the core reports unavailable gives NOT VERIFIED. The question check always reports NOT VERIFIED for both harnesses (`answer` is unsupported).
- `docs/d2/part-one-acceptance.md`: each check recorded as measured, seen or NOT VERIFIED, with the command and the output. It has a marked block (`LIVE-RESULTS-START`) for the host's live results.

## Commands and final counts

- `pytest tests/acceptance/d2 -v -rs`: 6 passed, 4 skipped (the live stage).
- `cd core && npm test`: 660 tests, 648 pass, 0 fail, 12 skipped. `npm run lint`, `typecheck` and `check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto -q` (core built): 1692 passed, 13 skipped, 1 failed. The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`. `uv build` has no package index here. Earlier task reports record the same failure.
- `check-example-node.py`, `scan-secrets.py`, `check-file-length.py`: clean. black, isort and `flake8 -j1` on `tests/acceptance/d2`: clean.
- Not run: the live stage (no gateway or credentials here), markdownlint, bandit, `harness-smoke.py`.

## Acceptance criteria

1. **Proven.** The five checks are the five `test_check*` tests in `test_mock.py`. All pass against the real CLI and real core.
2. **Partly proven.** The mock stage measures it (`test_third_submit_to_another_repository_is_fast_and_cancel_is_under_10_seconds`). The live test for both harnesses is written but was not run (NOT VERIFIED).
3. **Proven for what could run.** The record has every check with command and output. Live rows read NOT VERIFIED, with a place for the host's results.

## Choices and gaps

- The suite found no defect in merged code, so I changed none.
- Timing check 6 uses `runsPerRepository: 2` so that "2 runs in 1 repository" is a configured state. The third submit goes to another repository.
- Check 5 covers a killed worker and an honest success. It does not cover a live but silent worker (t9 covers that against fixtures). Checks 3 and 5 use the stub harness.
- I did not mutate the code to prove each assertion fails when the feature is broken.
- The live restart, steer, key and limit checks are not written for real harnesses; the record says so.
- The `core/node_modules` symlink was removed.

## Left unchanged on purpose

- All of `core/`, `culture_agents/` and `tests/acceptance/d1/` (imported, not edited).
