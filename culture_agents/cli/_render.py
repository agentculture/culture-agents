"""Result rendering: one payload, two views (``--json`` passthrough, or text).

A verb returns a :class:`Rendered`: a ``dict`` holding the payload (what
``--json`` prints, unchanged from the contract where the verb maps to a single
route) whose ``str()`` is the human text. agentfront's dispatcher prints one or
the other depending on ``--json``.
"""

from __future__ import annotations

from typing import Any


class Rendered(dict):
    """A JSON-serialisable payload with a separate text rendering."""

    def __init__(self, data: dict[str, Any], text: str) -> None:
        super().__init__(data)
        self._text = text

    def __str__(self) -> str:
        return self._text


def _val(value: Any) -> str:
    return "-" if value is None or value == "" else str(value)


def _flat(items: list[str]) -> str:
    return ", ".join(items) if items else "-"


def run_line(run: dict[str, Any]) -> str:
    return f"{run['id']}  {run['state']}  {run['harness']}  {run['repo']}"


def capability_lines(doc: dict[str, Any]) -> list[str]:
    """Honest capability report: every capability, supported or not, with why."""
    avail = "available" if doc["available"] else "unavailable"
    lines = [f"harness {doc['harness']} ({avail}, version {_val(doc.get('version'))})"]
    for name, cap in doc["capabilities"].items():
        if cap.get("supported"):
            note = f" [caveat: {'; '.join(cap['caveats'])}]" if cap.get("caveats") else ""
            lines.append(f"  {name}: supported{note}")
        else:
            lines.append(f"  {name}: UNSUPPORTED - {_val(cap.get('reason'))}")
    return lines


def agent_lines(agent: dict[str, Any]) -> list[str]:
    return [
        f"{agent['id']}  {agent['state']}",
        f"  harnesses: {_flat(agent['harnesses'])}",
        f"  repos: {_flat(agent['repos'])}",
        f"  active runs: {_flat(agent['active_run_ids'])}",
    ]


def agent_list(payload: dict[str, Any]) -> Rendered:
    lines = [f"node: {payload['node']}", f"agents ({len(payload['agents'])}):"]
    for agent in payload["agents"]:
        lines.extend(agent_lines(agent))
    for doc in payload["harnesses"]:
        lines.extend(capability_lines(doc))
    return Rendered(payload, "\n".join(lines))


def agent_status(agent: dict[str, Any], harnesses: list[dict[str, Any]]) -> Rendered:
    lines = agent_lines(agent)
    for doc in harnesses:
        lines.extend(capability_lines(doc))
    return Rendered({"agent": agent, "harnesses": harnesses}, "\n".join(lines))


def run_detail(run: dict[str, Any]) -> Rendered:
    rows = [
        ("id", run["id"]),
        ("agent", run["agent_id"]),
        ("harness", run["harness"]),
        ("repo", run["repo"]),
        ("state", run["state"] + (f" ({run['state_reason']})" if run["state_reason"] else "")),
        ("terminal", str(run["terminal"]).lower()),
        ("live control", str(run["live_control"]).lower()),
        ("owner", f"{run['owner']['kind']} {run['owner']['id']}"),
        ("created", run["created_at"]),
        ("started", _val(run["started_at"])),
        ("ended", _val(run["ended_at"])),
        ("deadline", _val(run.get("deadline"))),
        ("cursor", str(run["cursor"])),
        ("branch", _val(run["branch"])),
        ("task", run["task"]),
    ]
    return Rendered(run, "\n".join(f"{k}: {v}" for k, v in rows))


def run_list(payload: dict[str, Any]) -> Rendered:
    runs = payload["runs"]
    text = "\n".join(run_line(r) for r in runs) if runs else "no runs"
    return Rendered(payload, text)


def submitted(payload: dict[str, Any]) -> Rendered:
    run = payload["run"]
    return Rendered(payload, f"submitted {run['id']} ({run['state']})")


def accepted(payload: dict[str, Any]) -> Rendered:
    action = payload["action"]
    text = f"{action['kind']} {action['outcome']} for {action['run_id']} (action {action['id']})"
    return Rendered(payload, text)


def run_result(payload: dict[str, Any]) -> Rendered:
    lines = [f"run: {payload['run_id']}", f"state: {payload['state']}"]
    lines.append(f"ended: {_val(payload['ended_at'])}")
    lines.append(f"branch: {_val(payload['branch'])}")
    lines.append(f"commits: {_flat(payload['commits'])}")
    lines.append(f"summary: {_val(payload['summary'])}")
    err = payload.get("error")
    if err:
        lines.append(f"error: {err.get('code')}: {err.get('message')}")
    return Rendered(payload, "\n".join(lines))


def event_line(event: dict[str, Any]) -> str:
    """One compact line per event; ``data`` is untrusted text, shown verbatim."""
    data = event["data"]
    kind = event["kind"]
    if kind == "run.state":
        reason = f" ({data['reason']})" if data.get("reason") else ""
        detail = f"{_val(data.get('from'))} -> {data.get('to')}{reason}"
    elif kind == "run.output":
        detail = f"{data.get('channel')}: {data.get('text')}"
    elif kind in ("run.control", "run.refused"):
        detail = str(data.get("action"))
    elif kind == "run.error":
        err = data.get("error") or {}
        fatal = " (fatal)" if data.get("fatal") else ""
        detail = f"{err.get('code')}: {err.get('message')}{fatal}"
    else:
        detail = ""
    return f"#{event['cursor']} {event['time']} {kind} {detail}".rstrip()


def event_page(payload: dict[str, Any]) -> Rendered:
    lines = [event_line(e) for e in payload["events"]] or ["no events"]
    if payload["more"]:
        lines.append(f"more events follow: last cursor is {payload['last_cursor']}")
    return Rendered(payload, "\n".join(lines))
