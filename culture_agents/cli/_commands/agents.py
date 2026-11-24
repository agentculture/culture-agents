"""``agents agents list|status`` — the registry of agents the core knows.

Talks to the core's control socket (stdlib client in
:mod:`culture_agents.cli._client`). ``list`` is one call: the core returns every
agent together with every harness capability document.
"""

from __future__ import annotations

from urllib.parse import quote

from culture_agents.cli import _render
from culture_agents.cli._client import CoreClient
from culture_agents.cli._render import Rendered


def agents_list() -> Rendered:
    """List the agents the core knows, with every harness's capabilities."""
    return _render.agent_list(CoreClient().get("/v1/agents", "agent_list"))


def agents_status(agent_id: str) -> Rendered:
    """Show one agent and the capability document of each harness it can use."""
    client = CoreClient()
    agent = client.get(f"/v1/agents/{quote(agent_id, safe='')}", "agent")
    docs = [
        client.get(f"/v1/harnesses/{quote(h, safe='')}", "capabilities") for h in agent["harnesses"]
    ]
    return _render.agent_status(agent, docs)
