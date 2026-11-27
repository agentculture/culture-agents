# Task report: t26 — fetch a run's commits from the executing core as a git bundle; restrict cross-host reads

Branch base: `runs/d2-fleet` at f50a3b1. Covers spec targets c39 and h28.
The record of the work is `docs/d2/run-bundles.md`.

## What was built

- **Contract 3.3, a MINOR addition with new routes only.** It adds three routes:
  - `fleet.runs.logs`: `GET /v1/fleet/runs/{id}/events`, returning `event_page`, at most 50 events a page.
  - `fleet.runs.result`: `GET /v1/fleet/runs/{id}/result`, returning `run_result`.
  - `fleet.runs.bundle`: `GET /v1/fleet/runs/{id}/bundle`, returning bytes as `application/x-git-bundle`.

  No new field, enum value, event kind or schema file was added. `api_version`
  went from 3.2 to 3.3 in `contract/api.json`, `version.json`, the version
  fixtures and the CLI's `CLIENT_API_VERSION`. `contract/README.md` gained a
  "Changes in 3.3" section and three route rows. **The main agent needs to merge
  this 3.3 with the 3.3 additions of t24 and t25.**
- **Executing core** (`core/src/fleet/serve-runs.ts`, `core/src/fleet/bundle.ts`):
  - Over the fleet transport it serves `GET /v1/fleet/runs/{id}/result` and `.../bundle` only to the member that submitted the run. Any other member gets `denied` before anything of the run is read.
  - The bundle is `git bundle create <file> refs/heads/runs/<id> ^<base_commit>`. It holds one ref and only the commits after the run's base commit.
  - A run with no commits is `not_found`, an active run is `conflict`, and a bundle over 64 MiB is `unsupported` (`placement`).
- **Calling core** (`core/src/daemon/fleet-routes.ts`, `core/src/daemon/routes.ts`, `core/src/fleet/remote.ts`):
  - It forwards the three routes to the member that the run id's node names.
  - `Remote` gained `fetchBytes`, and each call can now carry its own minimum MINOR (3.3 for these routes), timeout and read cap. The bundle call gets 60 s and 64 MiB; every other call keeps 5 s.
  - A member that announced 3.2 is refused `unsupported` (`placement`) and nothing is sent to it.
- **Sensitivity mark (criterion 3): added, as the HTTP response header `Agents-Content-Sensitivity: unredacted`, not as a schema field.** It is set on cross-host logs, attach and bundle responses, both on the control socket and on the member's transport routes. A local read carries no mark. The reasoning is recorded in `docs/d2/run-bundles.md`, section "The sensitivity mark".
- **CLI** (`culture_agents/cli/_commands/runs.py`, new `culture_agents/cli/_fetch.py`, `_client.get_bytes`):
  - `agents runs result <id>` on a remote run reads the result from the member and fetches the bundle through the local core. It checks that the bundle is a git bundle holding exactly `refs/heads/runs/<id>`, then runs `git fetch` into `--into <checkout>`, or else into the checkout it runs in.
  - Outside a checkout, or with `--no-fetch`, it fetches nothing. `--json` carries `fetched`.
  - `agents runs logs` now follows the run id's node.
  - The explain entries for `runs result` and `runs logs` were updated.
- **Docs:**
  - New `docs/d2/run-bundles.md`.
  - `docs/d2/remote-runs.md` no longer lists t26 as not built.
  - One sentence was added to each of the five prompt files (CLAUDE.md, AGENTS.md, AGENTS.colleague.md, AGENTS.override.md, QWEN.md), and their API version line now says 3.3.

## Choices made where the plan text was open

- **Which checkout is the "caller's repository".** It is `--into <path>`, else the git checkout the CLI runs in. This matches how t23 picks the default base commit.
- **The bundle is thin.** Its prerequisite is the run's base commit, which keeps it to "only that run's" commits. So the caller's checkout must hold the base commit. That is true by default, because a remote submit sends that checkout's HEAD as the base. A caller who submitted with `--no-base` must fetch the base commit first, and the CLI's error says so.
- **Who may read.** This builds question 8 of the design record at its approved answer: only the local operator (on the socket) and the member that submitted the run (over the transport).
- **Error code for an oversized bundle.** It is `unsupported` with capability `placement`. The contract has no closer code that needs no new field.
- **Local runs.** `--into` on a local run is a usage error (exit 1), because that run's branch is already on this host.

## Tests run (final runs)

| Command | Result |
| --- | --- |
| `cd core && npm run build && npm test` | 839 tests: 827 pass, 0 fail, 12 skipped |
| `cd core && npm run lint` | clean |
| `cd core && npm run typecheck` | clean |
| `cd core && npm run check:contract-types` | clean |
| `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (repo root, after the core build) | 2067 passed, 1 failed, 13 skipped |
| `black --check`, `isort --check-only`, `flake8 -j1` (culture_agents, tests) | clean |
| `bandit -c pyproject.toml -r culture_agents` | clean |
| `python3 scripts/check-file-length.py` | all 362 files within 400 lines |
| `python3 scripts/scan-secrets.py` | clean |
| `python3 scripts/check-example-node.py` | clean |

**The one failure** is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`. `uv build` cannot fetch `hatchling` from PyPI because this sandbox has no network ("tcp connect error, Permission denied"). It failed the same way with my uncommitted changes stashed. It is environmental, not caused by this task, and the wheel build is **NOT VERIFIED** here.

**Not run:**

- `markdownlint-cli2`: not installed in this sandbox.
- `teken cli doctor . --strict`: it exits 2 with "cannot invoke 'agents'", because the shared venv does not install the `agents` entry point.
- `scripts/harness-smoke.py`: not run.

## Acceptance criteria

1. **Proven.** `agents runs result` on a remote run brings its runs branch into the caller's repository from a bundle served through the control API, with no shell access to the executing host.
   - `tests/acceptance/d2/test_remote_runs.py::test_result_brings_the_run_branch_into_the_callers_checkout_from_a_bundle` uses two real core processes, the real CLI and the stub harness. The caller's own clone receives `runs/<id>` at thor's tip, with the stub's files, and `GIT_SSH_COMMAND=false` is set for the CLI.
   - `core/test/fleet/bundle.test.ts` (first test) covers the same path with in-process cores and real git.
   - `tests/test_cli_run_bundle.py` covers the CLI: fetch into `--into` or the current checkout, nothing fetched outside a checkout or with `--no-fetch`, and a clear error when the base commit is missing.
2. **Proven.** The bundle holds only that run's ref and is served only to a caller allowed to read the run. Logs and attach across hosts follow the same rule and are not redacted.
   - Only that run's ref: `bundle.test.ts` (first test) checks that `git bundle list-heads` shows exactly `refs/heads/runs/<id>`, that a commit on another branch of thor is absent, and that the bundle needs the base commit, so it carries nothing older.
   - The CLI refuses a bundle that holds other refs, and anything that is not a bundle: `test_a_bundle_with_other_refs_or_not_a_bundle_is_refused`.
   - Only to an allowed reader: `bundle.test.ts` "only the member that submitted a run may read…" shows another trusted member gets 403 `denied` on result, bundle and events, and `getResult` is never called for it.
   - Not redacted: `bundle.test.ts` "logs and attach across hosts…" shows the remote event page is `deepEqual` to thor's local page and every stored event appears verbatim in the attach stream. The acceptance test also checks that the caller's `runs logs` events equal thor's.
3. **Proven, and the record says which way it went.** The mark was added as an HTTP header, not a schema field. The record is `docs/d2/run-bundles.md` ("The sensitivity mark") and `contract/README.md` ("Changes in 3.3"). `bundle.test.ts` asserts the header on remote logs, attach and bundle, and its absence on a local read.

## Existing tests updated (none deleted)

These tests pinned the API version, and they now say 3.3:

- `core/test/contract/v3.test.ts`, which also gained the 3.2-client and 3.2-core lines.
- `core/test/daemon/api.test.ts`.
- `core/test/fleet/remote-version.test.ts`: the test name now says "this core (3.3)", and the caller's announced version is asserted as `apiVersion`.
- `tests/test_cli_agents.py`, `tests/test_cli_runs.py` (3.2 was added to the refused-core cases), `tests/test_cli_version_3.py`, `tests/test_cli_remote_runs.py`, `tests/test_cli_runs_unreadable.py` and `tests/test_contract_v3.py` (renamed `…_version_3_3`).
- `tests/acceptance/d1/test_mock.py`: renamed `…_3_3_core`.
- `tests/acceptance/d2/test_fleet_members.py`.

Other test changes:

- `tests/test_contract_api.py`: the three new routes were added to the route set, and the consistency check now allows the one binary route.
- `core/test/fleet/remote-support.ts`: `MemberService.results` lets a test set a run's branch and commits.
- `tests/fake_core.py`: defaults for the three routes, and support for a bytes payload.

## Left unchanged on purpose

- The "**Not built:** D2 part two (… fetching a run's commits from another host) (planned)" sentence in CLAUDE.md and the other four prompt files. It is now stale on that one point. I left it alone to keep the shared paragraphs easy to merge with t24 and t25; the added sentence and `docs/d2/run-bundles.md` say the fetch is built. t28 rewrites these files to describe D2 as built.
- The CLI does not show the sensitivity header. It is meant for agents reading the API directly.
- `docs/d2/task-reports/`: no `t26.md` was added there; this file is the report.
- No dependency was added and `package.json` is unchanged. The `core/node_modules` symlink was removed and never committed.

## Not verified

- Two real hosts: everything ran on loopback on one machine (t28).
- A bundle near the 64 MiB cap, and the 60 s bundle timeout on a slow link: neither was measured.
- Claude Code and OpenCode on a remote run: only the fake service and the stub harness were used.

## Reasoning lapses noticed

- **Not test-first for part of the CLI.** The core work was test-first: the failing `core/test/fleet/bundle.test.ts` was committed in 264ac4c before the implementation in e838e11. For the CLI, I wrote `_fetch.py` and the `runs.py` changes before `tests/test_cli_run_bundle.py`, and they went into the same commit (ce23576).
- **A bug in my own first test fixture.** It submitted without a real base commit, so the fake run carried the fixture's base commit and `git bundle create` failed. I caught it on the first run, fixed the test to submit with the repository's HEAD as base, and made the core log git's stderr for such failures.
