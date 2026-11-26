"""D2 part one acceptance: restart recovery, idempotency, questions, limits, honest success.

Two stages, modelled on ``tests/acceptance/d1``. ``test_mock.py`` always runs: the
real ``agents`` CLI against the real core daemon (``core/dist``) with the stub
harness. ``test_live.py`` is opt-in (``CULTURE_AGENTS_ACCEPTANCE_LIVE=1``): it times
a third submit and a cancel on Claude Code and OpenCode v2, and reports each check
it cannot run as ``NOT VERIFIED``. The results are recorded in
``docs/d2/part-one-acceptance.md``.
"""
