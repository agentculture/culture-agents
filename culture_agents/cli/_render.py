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
    return lines + host_lines(doc)


def host_lines(doc: Any) -> list[str]:
    """Limits, active runs and admission per signal, when the core reports them."""
    lines: list[str] = []
    limits = _get(doc, "limits")
    if isinstance(limits, dict):
        for name, value in limits.items():
            text = "none set" if value is None else _val(value)
            lines.append(f"  limit {_val(name)}: {text}")
    if _get(doc, "active_runs") is not None:
        lines.append(f"  active runs: {_val(_get(doc, 'active_runs'))}")
    admission = _get(doc, "admission")
    for name, sig in admission.items() if isinstance(admission, dict) else ():
        note = "" if _get(sig, "consulted") is True else " (not consulted)"
        reason = _get(sig, "reason")
        why = f" - {_val(reason)}" if reason else ""
        seen = _get(sig, "observed_at")
        at = f" [observed {_val(seen)}]" if seen else ""
        lines.append(f"  admission {_val(name)}: {_val(_get(sig, 'state'))}{note}{why}{at}")
    return lines


def agent_lines(agent: Any) -> list[str]:
    return [
        f"{_val(_get(agent, 'id'))}  {_val(_get(agent, 'state'))}",
        f"  harnesses: {_flat(_get(agent, 'harnesses'))}",
        f"  repos: {_flat(_get(agent, 'repos'))}",
        f"  active runs: {_flat(_get(agent, 'active_run_ids'))}",
    ]


def _seconds(ms: Any) -> str:
    return f"{ms / 1000:.1f} s" if isinstance(ms, int) else "-"


def fleet_lines(fleet: Any) -> list[str]:
    """The member list: who announced themselves, and which announcements were refused."""
    if _get(fleet, "transport") != "on":
        return ["fleet: transport off (no members; set CULTURE_AGENTS_FLEET_LISTEN to join)"]
    interval, silence = _get(fleet, "announce_interval_ms"), _get(fleet, "silence_ms")
    members, refused = _items(_get(fleet, "members")), _items(_get(fleet, "refused"))
    lines = [
        f"fleet: transport on, announcing every {_seconds(interval)}, "
        f"a member silent for {_seconds(silence)} is dropped",
        f"members ({len(members)}):",
    ]
    for m in members:
        key = _val(_get(m, "fingerprint"))[:16]
        heard = _seconds(_get(m, "heard_ms_ago"))
        api = _val(_get(m, "api_version"))
        lines.append(f"  {_val(_get(m, 'node'))}  key {key}  api {api}  heard {heard} ago")
    if refused:
        lines.append(f"refused announcements ({len(refused)}):")
    for r in refused:
        lines.append(
            f"  claimed {_val(_get(r, 'node'))} by key {_val(_get(r, 'fingerprint'))[:16]} "
            f"(trusted as {_val(_get(r, 'trusted_as'))}), {_val(_get(r, 'count'))} time(s), "
            f"last {_seconds(_get(r, 'heard_ms_ago'))} ago: {_val(_get(r, 'reason'))}"
        )
    return lines


def agent_list(payload: Any, fleet: Any = None) -> Rendered:
    agents = _items(_get(payload, "agents"))
    lines = [f"node: {_val(_get(payload, 'node'))}", f"agents ({len(agents)}):"]
    for agent in agents:
        lines.extend(agent_lines(agent))
    for doc in _items(_get(payload, "harnesses")):
        lines.extend(capability_lines(doc))
    if fleet is None:
        return Rendered(payload, "\n".join(lines))
    lines.extend(fleet_lines(fleet))
    data = {**payload, "fleet": fleet} if isinstance(payload, dict) else {"fleet": fleet}
    return Rendered(data, "\n".join(lines))


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
    if _get(run, "base_commit"):  # absent on a run recorded before the core set it
        rows.insert(-1, ("base commit", _val(_get(run, "base_commit"))))
    if _get(run, "submitter"):
        rows.insert(-1, ("submitter", _submitter(_get(run, "submitter"))))
    lines = [f"{k}: {v}" for k, v in rows]
    for question in _items(_get(run, "pending_questions")):
        lines.extend(question_lines(question, "pending question"))
    return Rendered(run, "\n".join(lines))


def _submitter(sub: Any) -> str:
    """``local_user operator (uid 1000)`` or ``member thor``; ``-`` when not reported."""
    if not isinstance(sub, dict):
        return "-"
    kind = _val(_get(sub, "kind"))
    if _get(sub, "kind") == "member":
        return f"{kind} {_val(_get(sub, 'node'))}"
    name = _get(sub, "user")
    return (
        f"{kind} {_val(name)} (uid {_val(_get(sub, 'uid'))})"
        if name
        else (f"{kind} (uid {_val(_get(sub, 'uid'))})")
    )


def _choice(choice: Any) -> str:
    text = f"{_val(_get(choice, 'id'))} = {_val(_get(choice, 'label'))}"
    note = _get(choice, "description")
    return f"{text} ({_val(note)})" if note else text


def question_lines(question: Any, label: str) -> list[str]:
    """A question as the operator needs it to answer: id, kind, text, choices, time limit."""
    head = (
        f"{label}: {_val(_get(question, 'id'))} [{_val(_get(question, 'kind'))}] "
        f"{_val(_get(question, 'text'))}"
    )
    lines = [head]
    lines.extend(f"  choice: {_choice(c)}" for c in _items(_get(question, "choices")))
    lines.append(f"  answer by: {_val(_get(question, 'answer_by'))}")
    return lines


def run_list(payload: Any) -> Rendered:
    runs = _items(_get(payload, "runs"))
    text = "\n".join(run_line(r) for r in runs) if runs else "no runs"
    return Rendered(payload, text)


def submitted(payload: Any) -> Rendered:
    run = _get(payload, "run")
    head = f"submitted {_val(_get(run, 'id'))} ({_val(_get(run, 'state'))})"
    lines = [head]
    if _get(payload, "replayed") is True:
        lines.append("replayed: this key matched an earlier submit; nothing new was created")
    for warning in _items(_get(payload, "warnings")):
        lines.append(
            f"warning: {_val(_get(warning, 'code'))} ({_val(_get(warning, 'signal'))}): "
            f"{_val(_get(warning, 'message'))}"
        )
    return Rendered(payload, "\n".join(lines))


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
    elif kind == "run.question":
        detail = " / ".join(question_lines(_get(data, "question"), "question"))
    elif kind == "run.answer":
        detail = _answer_detail(data)
    else:
        detail = ""
    head = f"#{_val(_get(event, 'cursor'))} {_val(_get(event, 'time'))} {_val(kind)}"
    return f"{head} {detail}".rstrip()


def _answer_detail(data: Any) -> str:
    parts = [f"answer to {_val(_get(data, 'question_id'))}"]
    if _get(data, "decision") is not None:
        parts.append(f"decision {_val(_get(data, 'decision'))}")
    if _get(data, "choice_ids"):
        parts.append(f"choices {_flat(_get(data, 'choice_ids'))}")
    if _get(data, "answer") is not None:
        parts.append(f"text: {_val(_get(data, 'answer'))}")
    return ", ".join(parts)


def event_page(payload: Any) -> Rendered:
    lines = [event_line(e) for e in _items(_get(payload, "events"))] or ["no events"]
    if _get(payload, "more") is True:
        lines.append(f"more events follow: last cursor is {_val(_get(payload, 'last_cursor'))}")
    return Rendered(payload, "\n".join(lines))


def alias_list(payload: Any) -> Rendered:
    """A member's aliases (API 3.2): each alias and the agent and harness pairs it permits."""
    aliases = _items(_get(payload, "aliases"))
    lines = [f"member: {_val(_get(payload, 'node'))}", f"aliases ({len(aliases)}):"]
    for alias in aliases:
        permits = [
            f"{_val(_get(p, 'agent_id'))} on {_val(_get(p, 'harness'))}"
            for p in _items(_get(alias, "permits"))
        ]
        lines.append(f"  {_val(_get(alias, 'alias'))}: {', '.join(permits) or 'nothing permitted'}")
    return Rendered(payload, "\n".join(lines))
