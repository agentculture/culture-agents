"""Pytest fixtures shared across test modules."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.smoke_support import build_fixture


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    """A faithful fixture clone of the files the smoke check's config stage reads."""
    return build_fixture(tmp_path / "clone")


@pytest.fixture
def on_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty PATH containing only the fake tools a test plants."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    monkeypatch.setenv("PATH", str(bin_dir))
    return bin_dir


@pytest.fixture
def core(monkeypatch: pytest.MonkeyPatch):
    """A running fake core, with ``CULTURE_AGENTS_SOCKET`` pointing at it."""
    import shutil
    import tempfile

    from tests.fake_core import FakeCore

    # Unix socket paths are limited to ~108 bytes; keep this directory short.
    directory = Path(tempfile.mkdtemp(prefix="ca-"))
    fake = FakeCore(directory / "core.sock")
    monkeypatch.setenv("CULTURE_AGENTS_SOCKET", str(fake.socket_path))
    try:
        yield fake
    finally:
        fake.close()
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def no_core(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """``CULTURE_AGENTS_SOCKET`` pointing at a path nothing listens on."""
    missing = tmp_path / "none.sock"
    monkeypatch.setenv("CULTURE_AGENTS_SOCKET", str(missing))
    return missing
