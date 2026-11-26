# Task t15 report: list and remove finished run branches, with evidence

## What I built

- `contract/branches.json` (new schema, 3.0 additive): `branches` (list response), `remove_request`,
  `remove_response`. Two routes in `contract/api.json`: `GET /v1/branches?repo=` and
  `POST /v1/branches/remove`. Valid and invalid fixtures in `contract/fixtures/*/branches/`.
  Generated types regenerated (`core/src/contract/generated/branches.ts`, `index.ts`).
  `pyproject.toml` force-include list gained `contract/branches.json`.
- `core/src/runs/branches.ts`: `listBranches` and `removeBranches`.
  - Branches: `refs/heads/runs/<valid run id>`.
  - Evidence: `git merge-base --is-ancestor <tip> <ref>` against every local branch that is not a `runs/` branch, plus remote-tracking refs (not `*/HEAD`). `merged_into` names the first ref that contains the tip.
  - Deletion: `git branch -d -- <branch>` only. No `-D` or `--force` anywhere.
  - Skips, each reported with a reason: run active (`queued`/`running`/`cancelling`), run `unknown`, run unreadable (lookup throws), no run known, run recorded for another repository, no other ref contains the tip, or git itself refuses `-d` (for example a branch checked out in a worktree).
  - `dry_run` reports what would go and deletes nothing.
- `core/src/daemon/branch-routes.ts` plus two entries in `core/src/daemon/routes.ts`. The run state comes from the existing `RunService.getRun`, so the port and `service.ts` are untouched.
- CLI: `culture_agents/cli/_commands/branches.py` (`agents branches list|remove --repo [--dry-run]`, `--json` from agentfront), registered in `_app.py`. Explain entries in `culture_agents/explain/catalog_branches.py`. `_contract.py` has three new validation targets. `runs.py` is not touched.

## Choices where the plan was silent

- **Allow-list gate.** Both routes answer `denied` unless the repo (canonicalised) is named by some allow-list entry. Removing branches in an arbitrary path would be a write outside what the operator allowed. This is my reading, not plan text.
- **Another repository.** A run whose recorded `repo` differs from the requested repo counts as "not this repository's run" and is skipped.
- **Reachability.** "Another ref" excludes other `runs/` branches, so two run branches cannot vouch for each other.
- **`CORE_NOTE`.** I renamed `_CORE` to `CORE_NOTE` in `catalog_control.py` so the new catalog file can share it. Behaviour is unchanged.
- **Race.** There is a small window between the evidence check and `git branch -d`. Git's own merge check inside `-d` stands behind ours.

## Tests and commands (final counts)

- `cd core && npm run lint`: clean.
- `npm run typecheck`: clean.
- `npm run check:contract-types`: clean.
- `npm test`: 585 tests, 573 pass, 0 fail, 12 skipped. This includes the new `core/test/runs/branches.test.ts` (4 tests).
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1675 passed, 9 skipped, **1 failed**.
  - The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`. It runs `uv build`, which needs to download hatchling, and there is no network in this sandbox. I did not check whether it fails at baseline; the cause is the network error.
  - `test_the_wheel_is_told_to_carry_every_contract_json_file` failed at first because of the missing `pyproject.toml` entry. I fixed that and it now passes.
- `scripts/check-example-node.py`, `scripts/scan-secrets.py` and `scripts/check-file-length.py`: all clean.
- `teken cli doctor . --strict`: **25 of 26 checks pass, 1 error, so it did not pass.**
  - The failing check is `main_entry_contract`. It builds the package with `uv`, which tried to download `bandit` and failed with no network. It does not report anything about the branches verbs.
  - All learn, explain, overview, json and errors checks pass. I had to put a throwaway `agents` shim (in `/tmp`, not committed) on PATH because no `agents` executable is installed in this sandbox.
  - The criterion's "passes `teken cli doctor . --strict`" is therefore **partly proven**.

## Existing tests I updated (none deleted)

- `tests/test_contract.py`: `REQUIRED_SCHEMAS` gained `branches.json`.
- `tests/test_contract_api.py`: `D1_ROUTES` gained `branches.list` and `branches.remove`.
- `tests/fake_core.py`: default answers for the two new routes.

## Acceptance criteria

1. A core route and a CLI verb list every runs branch with its run's state: **proven.**
   - Core: `core/test/runs/branches.test.ts` ("list shows every runs branch…", and the route test).
   - CLI: `tests/test_cli_branches.py::test_list_text_shows_state_and_evidence`, `::test_list_json_is_the_contract_payload`.
2. Removal deletes only on git evidence, never forces, and skips and reports active, unknown and unreadable runs: **proven.**
   - `branches.test.ts` "removal deletes only a finished, reachable branch with git branch -d…" runs real git. It covers an unmerged branch, active, unknown, unreadable, absent, other-repo and a worktree-checked-out branch, and asserts every skipped branch still exists.
   - The same test records every git call, asserts `-d` is used, and asserts no `-D`, `--force` or `-f` is ever passed.
   - The dry-run test shows nothing is deleted.
3. `--json`, an explain catalog entry, and `teken cli doctor . --strict`: **partly proven.**
   - `--json`: `test_list_json_is_the_contract_payload` and `test_remove_dry_run_is_sent_and_worded`.
   - Explain entries: `test_every_branches_verb_has_an_explain_entry_and_a_json_flag`.
   - Strict doctor: see above, 25 of 26, with the one error caused by the missing network.

## Not run or not measured

- Live stage of the acceptance suite (`CULTURE_AGENTS_ACCEPTANCE_LIVE`): not run.
- The wheel build test needs network: failed here for that reason.
- No test starts a real core and drives the real `agents` CLI through the new verbs. The core route and the CLI are each tested against the other's contract fixtures, not end to end.

## Left unchanged on purpose

`core/src/runs/service.ts`, `core/src/runs/ports.ts`, `core/src/daemon/ports.ts`, `culture_agents/cli/_commands/runs.py`, `culture_agents/cli/_render.py`. The `core/node_modules` symlink was removed before this commit.
