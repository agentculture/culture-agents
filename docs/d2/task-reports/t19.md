# TASK-REPORT t19: documents for part one

## Built

- `docs/d2/part-one.md`: what exists, who it is for, the D1 state it replaced (with file references),
  why recovery is the condition for archiving agent-lifecycle and cultureagent, what a calling agent
  may rely on after a restart or retry, steer as non-preempting, the still-unsupported actions, and
  the seven gaps stated plainly.
- `docs/d2/corrections.md`: what was done to each stale record of the frame's follow-up item.
- `docs/d0/decisions.md` and `docs/d0/compatibility-matrix.md`: the OpenCode path marked settled
  (old comparison kept as history).
- CLAUDE.md, AGENTS.md, AGENTS.colleague.md, AGENTS.override.md, QWEN.md: part one on disk, part two
  and `pause`/`resume`/`artifacts` marked (planned), verb lists now include `runs answer` and
  `agents branches`, gaps stated.
- `tests/acceptance/d2/test_unsupported.py`: real core, stub harness.

## Tests run (final)

- `cd core && npm test`: 660 tests, 648 pass, 0 fail, 12 skipped. `npm run lint`, `npm run typecheck`: clean.
  `npm run check:contract-types`: not run (no contract change).
- `/usr/local/share/dogfood/venv/bin/python -m pytest -n auto`: 1693 passed, 13 skipped, 1 failed.
  The failure is `tests/test_contract_packaging.py::test_a_built_wheel_holds_the_schemas_byte_for_byte`
  (needs the package index; t10 reported the same; not checked on main).
- `scripts/harness-smoke.py --stage config`: 6 passed, 0 failed.
- `scan-secrets.py`, `check-example-node.py`, `check-file-length.py`: clean.
- `markdownlint-cli2`: not installed, not run. Some bullet lines I added are longer than 80 columns.
- `core/node_modules` symlink removed.

## Acceptance

1. Proven: harness-smoke config stage passes (6/6). That the files say part one and mark part two
   planned was checked by reading, no test asserts the wording.
2. Partly proven: `docs/d2/part-one.md` has all three parts; the claims are from the task reports and
   code reading, no test checks the document. Choice: the spec does not name which recovery tests
   D2 passes versus leaves for D6, so the document says part one supplies evidence and the archiving
   decision is the owner's, D6 at the earliest. It does not claim a list.
3. Proven for the test: `tests/acceptance/d2/test_unsupported.py` asserts pause and resume are 422
   `unsupported` with their capability, `delegate` is unsupported in the capability document and a
   submit with `parent_run_id` is refused, and there is no artifacts route (404) or verb. Steer
   non-preemption is documented only (source: spec lines 248, 268), not tested here. Stale records:
   corrected, except the published explainer (outside the repo, owner must republish).

## Choices and notes

- Artifacts has no route or verb, so "answers unsupported" is shown as 404 and a CLI refusal, and the
  docs say "no route or verb (planned)", not "unsupported".
- The D1 frame's parked gateway item sits in a confirmed spec I may not edit; the correction is
  in `docs/d2/corrections.md`.
- `contract/README.md` route step 7 still says live_control false gives `unsupported` `reconnect`,
  which t9 changed to `unavailable`; I left that file alone (not in scope). Worth a fix.
- No real host name was written. Existing `host.openshell.internal` is a sandbox alias already in
  `docs/d0/probe.md`.

## Left unchanged on purpose

`docs/d2/part-one-acceptance.md` (main agent fills live rows), docs/specs, docs/plans, .devague, task
reports, CHANGELOG.md, version files.
