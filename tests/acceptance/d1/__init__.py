"""D1 acceptance: dispatch, inspect, steer and cancel an agent without chat.

Two stages. ``test_mock.py`` always runs: the real ``agents`` CLI (a
subprocess) against the real core daemon (``core/dist``), with the stub
harness, so no sandbox, gateway or model is needed. ``test_live.py`` runs the
same checks on Claude Code and OpenCode v2 in an OpenShell sandbox, only when
``CULTURE_AGENTS_ACCEPTANCE_LIVE=1`` and the harness is available; otherwise
each live check is skipped as ``NOT VERIFIED`` and never counts as a pass.
"""
