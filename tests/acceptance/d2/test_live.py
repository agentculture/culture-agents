"""D2 part one acceptance, live stage: Claude Code and OpenCode v2 in an OpenShell sandbox.

Opt-in (``CULTURE_AGENTS_ACCEPTANCE_LIVE=1``). A harness the core reports as unavailable
gives ``NOT VERIFIED``, never a pass. No turn is given a hard time limit that would kill a
slow local model: the waits are generous and only the two measured times are asserted.
Results go to ``$CULTURE_AGENTS_ACCEPTANCE_REPORT`` and by hand into
``docs/d2/part-one-acceptance.md``.
"""

from __future__ import annotations

import time

import pytest

from tests.acceptance.d1.support import Core, not_verified, record
from tests.acceptance.d1.test_live import TASKS, TURN_TIMEOUT

HARNESSES = pytest.mark.parametrize("live_core", sorted(TASKS), indirect=True)


@HARNESSES
def test_live_third_submit_is_fast_and_cancel_is_under_10_seconds(live_core: Core) -> None:
    """With 2 runs active in 1 repository, a third submit to another repository is fast."""
    harness = live_core.harnesses[0]
    busy, other = live_core.add_repo(), live_core.add_repo()
    hang = TASKS[harness]["hang"]
    first, _ = live_core.submit(harness, busy, hang)
    second, _ = live_core.submit(harness, busy, hang)
    third, submit_seconds = live_core.submit(harness, other, hang)
    live_core.wait_outputs(third["id"], "tool_call", 1, TURN_TIMEOUT)
    time.sleep(3)

    start = time.monotonic()
    live_core.ok("runs", "cancel", third["id"], "--reason", "acceptance")
    done = live_core.wait_terminal(third["id"], 60)
    cancel_seconds = time.monotonic() - start
    record(
        "live.d2.timing",
        harness=harness,
        submit_seconds=round(submit_seconds, 3),
        cancel_seconds=round(cancel_seconds, 2),
        state=done["state"],
    )
    for run in (first, second):
        live_core.ok("runs", "cancel", run["id"])
    assert submit_seconds < 2.0, f"third submit took {submit_seconds:.2f} s"
    assert done["state"] == "cancelled"
    assert cancel_seconds < 10.0, f"cancel took {cancel_seconds:.1f} s"


@pytest.mark.parametrize("harness", sorted(TASKS))
def test_live_question_check_is_not_verified_on_real_harnesses(harness: str) -> None:
    """Claude Code and OpenCode report ``answer`` unsupported: only the stub can ask (t13)."""
    record("live.d2.question", harness=harness, result="NOT VERIFIED")
    not_verified(f"{harness} reports answer unsupported until its driver has an ask path")
