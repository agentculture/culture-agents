"""Result rendering: one payload, two views (``--json`` passthrough, or text).

A verb returns a :class:`Rendered`: a ``dict`` holding the payload (what
``--json`` prints, unchanged from the contract where the verb maps to a single
route) whose ``str()`` is the human text. agentfront's dispatcher prints one or
the other depending on ``--json``.

Two rules hold for the text view:

* Every value is passed through :func:`culture_agents.cli._text.visible`. Task
  text, harness output, summaries, reasons and error messages were written by a
  run and are untrusted, so control characters are shown, never sent to the
  terminal, and one field can never spill onto a second line.
* Rendering never raises. Payloads are schema-validated before they get here,
  but a missing key or a value of the wrong type still renders (as ``-``).
"""

from __future__ import annotations

from typing import Any

from culture_agents.cli._text import visible


class Rendered(dict):
    """A JSON-serialisable payload with a separate text rendering."""

    def __init__(self, data: Any, text: str) -> None:
        super().__init__(data if isinstance(data, dict) else {})
        self._text = text

    def __str__(self) -> str:
        return self._text


def _get(obj: Any, *keys: str) -> Any:
    """``obj[k1][k2]...``, or ``None`` as soon as a level is not an object or lacks the key."""
    for key in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def _items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _val(value: Any) -> str:
    return "-" if value is None or value == "" else visible(value)


def _flag(value: Any) -> str:
    return str(value).lower() if isinstance(value, bool) else _val(value)


def _flat(items: Any) -> str:
    return ", ".join(_val(item) for item in _items(items)) or "-"


def run_line(run: Any) -> str:
    fields = (_get(run, key) for key in ("id", "state", "harness", "repo"))
    return "  ".join(_val(field) for field in fields)


def capability_lines(doc: Any) -> list[str]:
    """Honest capability report: every capability, supported or not, with why."""
    available = _get(doc, "available")
    avail = {True: "available", False: "unavailable"}.get(available, _val(available))
    version = _val(_get(doc, "version"))
    lines = [f"harness {_val(_get(doc, 'harness'))} ({avail}, version {version})"]
    capabilities = _get(doc, "capabilities")
    for name, cap in capabilities.items() if isinstance(capabilities, dict) else ():
        if _get(cap, "supported") is True:
            caveats = _items(_get(cap, "caveats"))
            note = f" [caveat: {'; '.join(_val(c) for c in caveats)}]" if caveats else ""
            lines.append(f"  {_val(name)}: supported{note}")
        else:
            lines.append(f"  {_val(name)}: UNSUPPORTED - {_val(_get(cap, 'reason'))}")
    return lines


def agent_lines(agent: Any) -> list[str]:
    return [
        f"{_val(_get(agent, 'id'))}  {_val(_get(agent, 'state'))}",
        f"  harnesses: {_flat(_get(agent, 'harnesses'))}",
        f"  repos: {_flat(_get(agent, 'repos'))}",
        f"  active runs: {_flat(_get(agent, 'active_run_ids'))}",
    ]


def agent_list(payload: Any) -> Rendered:
    agents = _items(_get(payload, "agents"))
    lines = [f"node: {_val(_get(payload, 'node'))}", f"agents ({len(agents)}):"]
    for agent in agents:
        lines.extend(agent_lines(agent))
    for doc in _items(_get(payload, "harnesses")):
        lines.extend(capability_lines(doc))
    return Rendered(payload, "\n".join(lines))


def agent_status(agent: Any, harnesses: Any) -> Rendered:
    lines = agent_lines(agent)
    for doc in _items(harnesses):
        lines.extend(capability_lines(doc))
    return Rendered({"agent": agent, "harnesses": harnesses}, "\n".join(lines))


def run_detail(run: Any) -> Rendered:
    reason = _get(run, "state_reason")
    state = _val(_get(run, "state")) + (f" ({_val(reason)})" if reason else "")
    owner = f"{_val(_get(run, 'owner', 'kind'))} {_val(_get(run, 'owner', 'id'))}"
    rows = [
        ("id", _val(_get(run, "id"))),
        ("agent", _val(_get(run, "agent_id"))),
        ("harness", _val(_get(run, "harness"))),
        ("repo", _val(_get(run, "repo"))),
        ("state", state),
        ("terminal", _flag(_get(run, "terminal"))),
        ("live control", _flag(_get(run, "live_control"))),
        ("owner", owner),
        ("created", _val(_get(run, "created_at"))),
        ("started", _val(_get(run, "started_at"))),
        ("ended", _val(_get(run, "ended_at"))),
        ("deadline", _val(_get(run, "deadline"))),
        ("cursor", _val(_get(run, "cursor"))),
        ("branch", _val(_get(run, "branch"))),
        ("task", _val(_get(run, "task"))),
    ]
    return Rendered(run, "\n".join(f"{k}: {v}" for k, v in rows))


def run_list(payload: Any) -> Rendered:
    runs = _items(_get(payload, "runs"))
    text = "\n".join(run_line(r) for r in runs) if runs else "no runs"
    return Rendered(payload, text)


def submitted(payload: Any) -> Rendered:
    run = _get(payload, "run")
    return Rendered(payload, f"submitted {_val(_get(run, 'id'))} ({_val(_get(run, 'state'))})")


def _action(action: Any) -> str:
    """``steer accepted for <run>`` (plus the refusal, when there is one)."""
    text = (
        f"{_val(_get(action, 'kind'))} {_val(_get(action, 'outcome'))} "
        f"for {_val(_get(action, 'run_id'))} (action {_val(_get(action, 'id'))})"
    )
    error = _get(action, "error")
    return f"{text}: {_error(error)}" if error else text


def _error(error: Any) -> str:
    return f"{_val(_get(error, 'code'))}: {_val(_get(error, 'message'))}"


def accepted(payload: Any) -> Rendered:
    return Rendered(payload, _action(_get(payload, "action")))


def run_result(payload: Any) -> Rendered:
    lines = [
        f"run: {_val(_get(payload, 'run_id'))}",
        f"state: {_val(_get(payload, 'state'))}",
        f"ended: {_val(_get(payload, 'ended_at'))}",
        f"branch: {_val(_get(payload, 'branch'))}",
        f"commits: {_flat(_get(payload, 'commits'))}",
        f"summary: {_val(_get(payload, 'summary'))}",
    ]
    error = _get(payload, "error")
    if error:
        lines.append(f"error: {_error(error)}")
    return Rendered(payload, "\n".join(lines))


def event_line(event: Any) -> str:
    """One line per event. Everything in ``data`` is untrusted text and is shown escaped."""
    data = _get(event, "data")
    kind = _get(event, "kind")
    if kind == "run.state":
        reason = _get(data, "reason")
        detail = f"{_val(_get(data, 'from'))} -> {_val(_get(data, 'to'))}"
        detail += f" ({_val(reason)})" if reason else ""
    elif kind == "run.output":
        detail = f"{_val(_get(data, 'channel'))}: {visible(_get(data, 'text') or '')}"
    elif kind in ("run.control", "run.refused"):
        detail = _action(_get(data, "action"))
    elif kind == "run.error":
        fatal = " (fatal)" if _get(data, "fatal") is True else ""
        detail = f"{_error(_get(data, 'error'))}{fatal}"
    else:
        detail = ""
    head = f"#{_val(_get(event, 'cursor'))} {_val(_get(event, 'time'))} {_val(kind)}"
    return f"{head} {detail}".rstrip()


def event_page(payload: Any) -> Rendered:
    lines = [event_line(e) for e in _items(_get(payload, "events"))] or ["no events"]
    if _get(payload, "more") is True:
        lines.append(f"more events follow: last cursor is {_val(_get(payload, 'last_cursor'))}")
    return Rendered(payload, "\n".join(lines))
