"""``agents whoami`` — the smallest identity probe.

Reports the agent's identity as declared in ``culture.yaml``: its nick
(``suffix``), the backend it runs on, and the served model (if any) — plus the
package version. Read-only; touches nothing but its own ``culture.yaml``.

Edit ``culture.yaml`` and ``whoami`` reflects the new identity with no code change.
"""

from __future__ import annotations

from pathlib import Path

from culture_agents import __version__
from culture_agents.cli._render import Rendered

_FALLBACK_NICK = "culture-agents"


def find_culture_yaml() -> Path | None:
    """Locate this agent's own ``culture.yaml`` by walking up from this module.

    The identity must be the agent's own, not whatever ``culture.yaml`` happens
    to sit in the caller's current working directory. In an editable / source
    install, walking up from ``__file__`` finds the repo root; in a wheel
    install no ``culture.yaml`` ships alongside the package and the caller falls
    back to the literal defaults.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "culture.yaml"
        if candidate.is_file():
            return candidate
    return None


def read_agent_fields() -> dict[str, str]:
    """Return ``suffix``/``backend``/``model`` from the first agent block.

    Parsed without a YAML dependency to keep the runtime deps empty. Reads
    top-level ``key: value`` lines within the first agent entry; anything
    fancier than the documented shape falls back to the defaults below.
    """
    fields = {"nick": _FALLBACK_NICK, "backend": "unknown", "model": "unknown"}
    cfg = find_culture_yaml()
    if cfg is None:
        return fields
    try:
        text = cfg.read_text(encoding="utf-8")
    except OSError:
        return fields
    seen_agent = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("- suffix:", "suffix:")):
            if seen_agent:  # second agent block — stop at the first
                break
            seen_agent = True
            fields["nick"] = _scalar(stripped, "suffix")
        elif seen_agent and stripped.startswith("backend:"):
            fields["backend"] = _scalar(stripped, "backend")
        elif seen_agent and stripped.startswith("model:"):
            fields["model"] = _scalar(stripped, "model")
    return fields


def _scalar(line: str, key: str) -> str:
    """Extract the scalar after ``key:`` from a ``culture.yaml`` line."""
    _, _, value = line.partition(f"{key}:")
    return value.strip().strip("'\"") or "unknown"


def report() -> dict[str, object]:
    fields = read_agent_fields()
    return {
        "nick": fields["nick"],
        "version": __version__,
        "backend": fields["backend"],
        "model": fields["model"],
    }


def whoami() -> Rendered:
    """Report this agent's nick, version, backend, and served model."""
    identity = report()
    text = (
        f"nick: {identity['nick']}\n"
        f"version: {identity['version']}\n"
        f"backend: {identity['backend']}\n"
        f"model: {identity['model']}"
    )
    return Rendered(identity, text)
