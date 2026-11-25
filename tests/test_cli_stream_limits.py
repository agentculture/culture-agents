"""The CLI's event-stream reader refuses an oversized line instead of buffering it."""

from __future__ import annotations

import io

import pytest

from culture_agents.cli import _stream
from culture_agents.cli._errors import CliError


def test_an_oversized_stream_line_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_stream, "_MAX_LINE_BYTES", 64)
    resp = io.BytesIO(b"data: " + b"x" * 200)
    with pytest.raises(CliError) as caught:
        list(_stream.parse_sse(resp))  # type: ignore[arg-type]
    assert "stream line over 64 bytes" in str(caught.value)


def test_a_line_at_the_limit_is_still_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_stream, "_MAX_LINE_BYTES", 64)
    resp = io.BytesIO(b": keepalive\n\n")
    assert list(_stream.parse_sse(resp)) == []  # type: ignore[arg-type]
