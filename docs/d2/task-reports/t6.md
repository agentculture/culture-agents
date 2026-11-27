# Task report: t6, idempotent submit, steer and cancel

Plan `d2-fleet-and-recovery`, task t6 (covers c6, h6, c51, h39).

## What I built

- `core/src/store/idempotency.ts` (new): the on-disk key index. There is one
  0600 JSON file per key in `<stateDir>/keys/` (a 0700 directory), named
  `<scope>-<sha256(key)>.json`. Each file is written with a temp file and a
  rename, and both the file and the directory are fsynced. An entry holds the
  route (`submit`, `steer` or `cancel`), the key, a `sha256:` digest of the
  request, the run id, its state (`reserved` or `established`) and, for steer
  and cancel, the action record. The module also has:
  - `requestDigest`: canonical JSON with sorted keys, minus `idempotency_key`,
    plus the route and the run id from the path;
  - `settleKey` and `recoverKeys`: settle a reserved key from the store, which
    is the only evidence;
  - `pruneKeys` (retention) and a per-key in-process `exclusive` lock.
- `core/src/runs/keys.ts` (new): the replay and conflict logic for the routes.
  A repeat returns `replayed: true`. A changed request gets `conflict` with
  `retryable: false`, plus `idempotency_key` and `run_id`. A key whose first
  submit is still being set up (a worker that is alive but not durable yet)
  gets `unavailable` with `retry_after_ms`.
- `core/src/runs/service.ts`, submit path. The key is checked after the
  capability checks and before the busy check. The order on disk is: key file
  (fsynced), then the run directory, then the worker spawn, then the key is
  marked established, then the acknowledgement. There are three fault
  injection points (`submitFault`: `after-key`, `after-run-dir`,
  `after-spawn`). `after-run-dir` runs through a new `onCreated` hook in
  `spawnWorker` (`core/src/worker/spawn.ts`). If the spawn fails, the key is
  kept only when the run reached event 1; otherwise it is released.
  `reconcile()` now settles reserved keys first (`recoverKeys`), then prunes
  old keys.
- Steer and cancel (`service.ts` `keyed`, plus a `beforeDeliver` hook in
  `core/src/runs/control.ts`). A repeat returns the first action record and
  delivers nothing. A new key is written, reserved with the action id, just
  before delivery. It is marked established once the worker accepts, and
  released when the action is refused or was never recorded as `run.control`.
- The port change: `RunService.submit` now returns `SubmitResponse` and
  `steer`/`cancel` return `AcceptedResponse`, so `replayed` can reach the wire.
  `routes.ts` was updated to match.
- Test-only wiring: `MainOptions.submitFault` (`core/src/daemon/main.ts`). The
  test child (`core/test/runs/child.ts`) reads `SUBMIT_FAULT=<step>` and
  SIGKILLs itself at that step, which is a real kill with no cleanup code run.
- `contract/README.md`:
  - the submit order of checks now has the key at step 6, busy at step 7 and
    create at step 8, and t8's limit now "replaces step 7";
  - the control-route rule is marked built;
  - the Idempotency keys section now states the two rules t6 had to write: what
    "the same request" means, and how long a key is remembered;
  - the t6 rows in the 3.0 table are marked built.
- `culture_agents/explain/catalog_control.py`: the `--idempotency-key` line no
  longer says "recorded, not deduplicated".

## Choices I made where the plan is open

- **One namespace per route:** the same key on a submit and on a steer counts
  as two different keys. For steer and cancel, the run id is part of the
  digest, so reusing a key on another run is a `conflict`.
- **`caller` counts** toward "the same request" (every body field except the
  key counts).
- **Retention:** a key is kept as long as its run is in the store, and for 7
  days after the run ended (`keyRetentionMs`, default `KEY_RETENTION_MS`).
  Expired keys are pruned only when the core starts. The spec (s5) asks for
  "an expiry" without a value; the 7 days is my choice.
- **A replay skips the busy check.** Otherwise a repeat while the first run is
  active would get `busy` instead of the first run.
- **A repeated steer or cancel replays even after the run became terminal.**
  It returns the first action and does not raise a state `conflict`.
- **A refused steer or cancel does not use up its key.**

## Test commands and final counts

- `cd core && npm run build && npm test`: 592 tests, 580 pass, 0 fail,
  12 skipped. The skips were already in the suite before this task; I did not
  add any.
- `cd core && npm run lint`: clean.
- `cd core && npm run typecheck`: clean.
- `cd core && npm run check:contract-types`: clean.
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto` (repo root,
  after the core build): 1606 passed, 1 failed, 9 skipped.
  - The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`.
    It runs `uv build`, which fails with
    `tcp connect error ... Permission denied (os error 13)`. This sandbox has
    no network or package registry, so the failure comes from the environment,
    not from this change. I did not check whether it also fails without my
    change.
  - The 9 skips are the opt-in live stage (NOT VERIFIED) and the check that
    needs a sibling `culture` checkout.
- `python3 scripts/check-file-length.py`, `scripts/scan-secrets.py` and
  `scripts/check-example-node.py`: all pass.
- `black --check` and `flake8 -j1` on `culture_agents tests`: clean. Plain
  `flake8` cannot start its process pool in this sandbox, so I used `-j1`.
- **Not run:** markdownlint (the tool is not installed), isort, bandit,
  `teken cli doctor`, and `harness-smoke.py`.

## Acceptance criteria

1. **Proven.** Test: `core/test/runs/idempotency.test.ts`, "a repeated submit
   key returns the first run and creates nothing; a changed request is
   conflict; both hold after a restart". What it checks:
   - the key file and its `sha256:` digest are on disk;
   - a repeat (fields reordered) returns `replayed: true` with the same id, and
     there is still exactly one run directory;
   - a changed task gets `conflict` with `idempotency_key`, `run_id` and
     `retryable: false`;
   - after a SIGKILL and a new core, the replay and the conflict both still
     hold.

   That the key is on disk *before* the acknowledgement is shown by the
   `after-spawn` kill test: the core dies after the spawn and before it
   answers, and the key file is already there.
2. **Proven.** Test: "steer and cancel sent 2 times with 1 key each take effect
   once in the event log, also after a restart". It sends each one twice and
   counts exactly one `run.control` steer and one cancel in the event log. The
   same steer key gives the same action id again after a core restart. A
   changed message or reason gets `conflict`. A related test, "a refused steer
   does not use up its key", shows the key is released on refusal.
3. **Proven.** Three tests, "a submit killed after-key / after-run-dir /
   after-spawn ...". Each one:
   - SIGKILLs the core at that step through `SUBMIT_FAULT`;
   - checks the key was on disk, and the run directory only from
     `after-run-dir` on;
   - restarts the core;
   - checks the key was released when its run was never established
     (`after-key`, `after-run-dir`) and kept for `after-spawn`;
   - checks the repeat gives exactly one run in both the listing and the
     store, that every live worker in the store is listed, and that a third
     send replays.

   A mutation check: with `recoverKeys` disabled, the `after-key` and
   `after-run-dir` tests fail. I restored it before committing.
   Unit tests for the index are in `core/test/store/idempotency.test.ts`.

## Deviations, skips and assumptions

- **I did not work test-first:** I wrote the implementation before the tests,
  so the tests never failed against an unimplemented core. To make up for that
  I ran the mutation check described under criterion 3.
- **Updated existing tests** (none deleted):
  - `core/test/runs/reattach.test.ts`: `accepted.kind` became
    `accepted.action.kind` because of the port change;
  - `core/test/daemon/fake-service.ts`: the fake returns the new response
    shapes;
  - `core/test/runs/child.ts`: `SUBMIT_FAULT` was added.
- **Possible unlisted worker (handled, not tested):** the core could die after
  the worker started but before the worker wrote event 1. The key then stays
  reserved, and a repeat gets `unavailable` with retry until the worker is
  durable or gone. There is no fault injection point for that window, so no
  test covers it.
- **Concurrency limit:** two concurrent steers with one key are serialized only
  within one core process (`exclusive`). The state-directory lock rules out a
  second core.
- **Left unchanged on purpose:**
  - the CLI's key generation and retry (that is t16);
  - the `busy` rule (t8);
  - `docs/specs` and `docs/plans`;
  - the files with `openshell-RESOLVE-PLACEHOLDER` (none of the failures came
    from them);
  - `.claude/skills`, `.devague` and `spikes`.
- No new dependency. The `core/node_modules` symlink was removed and is not
  committed.
