"""Fixtures: a real core with the stub harness (mock stage) or the real harnesses (live)."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from tests.acceptance.d1.support import Core, not_verified, require_core_build

LIVE_ENV = "CULTURE_AGENTS_ACCEPTANCE_LIVE"
HERMETIC = {
    "stub": True,
    "dockerBin": "/nonexistent/docker",
    "openshellBin": "/nonexistent/openshell",
}


@pytest.fixture
def core() -> Iterator[Core]:
    """A running core that lists only the stub harness as available: no sandbox, no model."""
    require_core_build()
    instance = Core(["stub"], HERMETIC)
    try:
        instance.start()
        yield instance
    finally:
        instance.close()


@pytest.fixture
def live_core(request: pytest.FixtureRequest) -> Iterator[Core]:
    """A running core over the real harness in ``request.param``, or NOT VERIFIED."""
    harness = request.param
    if os.environ.get(LIVE_ENV) != "1":
        not_verified(f"live turns are opt-in: set {LIVE_ENV}=1 ({harness})")
    require_core_build()
    instance = Core([harness], {"sandboxPrefix": "acc-"}, live=True)
    try:
        instance.start()
        listed = instance.ok("agents", "list")["harnesses"]
        doc = next((h for h in listed if h["harness"] == harness), None)
        if doc is None or not doc["available"]:
            not_verified(f"the core reports {harness} as unavailable (gateway, image or provider)")
        yield instance
    finally:
        instance.close()
