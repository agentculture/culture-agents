"""``agents agents list|status`` — the registry of agents the core knows.

Talks to the core's control socket (stdlib client in
:mod:`culture_agents.cli._client`). ``list`` is two calls: the core returns every
agent together with every harness capability document, and then the fleet
members it heard announce themselves (API 3.1), which ``--json`` prints under
``fleet``. The member list comes from announcements only; no host list is kept.
"""

from __future__ import annotations

from urllib.parse import quote

from culture_agents.cli import _render
from culture_agents.cli._client import CoreClient
from culture_agents.cli._render import Rendered


def agents_list() -> Rendered:
    """List the agents the core knows, every harness's capabilities and the fleet members."""
    client = CoreClient()
    agents = client.get("/v1/agents", "agent_list")
    return _render.agent_list(agents, client.get("/v1/fleet/members", "member_list"))


def agents_status(agent_id: str) -> Rendered:
    """Show one agent and the capability document of each harness it can use."""
    client = CoreClient()
    agent = client.get(f"/v1/agents/{quote(agent_id, safe='')}", "agent")
    docs = [
        client.get(f"/v1/harnesses/{quote(h, safe='')}", "capabilities") for h in agent["harnesses"]
    ]
    return _render.agent_status(agent, docs)
