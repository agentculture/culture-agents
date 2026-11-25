/**
 * Agents and harnesses as reported by the core. In D1 an agent is known exactly when an allow-list
 * entry names it; its harnesses and repositories are the union of its entries (contract agent.json).
 */
import { isActive, parseMeshId, type Agent, type Allowlist, type Capabilities, type Run } from "../contract/index.js";
import { canonicalRepo } from "../daemon/allowlist.js";
import type { HarnessCatalog } from "./ports.js";

/** Every harness capability document in the catalog, in catalog order. */
export async function harnessDocuments(catalog: HarnessCatalog): Promise<Capabilities[]> {
  return Promise.all(catalog.list().map((entry) => entry.capabilities()));
}

type AgentState = "idle" | "running" | "unavailable";

function compareIds(a: Agent, b: Agent): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** Build the agents named by the allow-list entries, with their active runs from the store. */
export function buildAgents(entries: Allowlist["entries"], runs: readonly Run[], harnesses: readonly Capabilities[]): Agent[] {
  const available = new Set(harnesses.filter((h) => h.available).map((h) => h.harness));
  const byId = new Map<string, { harnesses: Set<string>; repos: Set<string> }>();
  for (const entry of entries) {
    if (parseMeshId(entry.agent_id) === null) continue;
    const agent = byId.get(entry.agent_id) ?? { harnesses: new Set<string>(), repos: new Set<string>() };
    agent.harnesses.add(entry.harness);
    agent.repos.add(canonicalRepo(entry.repo) ?? entry.repo);
    byId.set(entry.agent_id, agent);
  }
  const agents: Agent[] = [];
  for (const [id, info] of byId) {
    const mesh = parseMeshId(id);
    if (mesh === null) continue;
    const active = runs.filter((run) => run.agent_id === id && isActive(run.state)).map((run) => run.id);
    let state: AgentState = "running";
    if (active.length === 0) state = [...info.harnesses].some((h) => available.has(h)) ? "idle" : "unavailable";
    agents.push({
      id,
      node: mesh.node,
      suffix: mesh.agent,
      harnesses: [...info.harnesses],
      repos: [...info.repos],
      state,
      active_run_ids: active,
    });
  }
  return agents.sort(compareIds);
}
