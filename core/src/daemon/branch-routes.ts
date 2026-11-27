import type { IncomingMessage, ServerResponse } from "node:http";

import { validate, type RemoveRequest } from "../contract/index.js";
import { listBranches, removeBranches } from "../runs/branches.js";
import { canonicalRepo, type AllowlistState } from "./allowlist.js";
import { ControlError, invalid } from "./errors.js";
import { checkBody, readJsonBody, sendJson } from "./http.js";
import type { RunService } from "./ports.js";

interface BranchCall {
  service: RunService;
  allowlist: () => AllowlistState;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
}

/** The canonical repository, when the allow-list names it for some agent; else `denied` (nothing is run or deleted elsewhere). */
function permittedRepo(allowlist: AllowlistState, repo: string, field: string): string {
  if (!validate("common#repo_path", repo).ok) throw invalid(`${field} must be an absolute repository path.`, field);
  const canonical = canonicalRepo(repo);
  const allowed = canonical !== null && allowlist.entries.some((e) => (canonicalRepo(e.repo) ?? e.repo) === canonical);
  if (canonical === null || !allowed) {
    throw new ControlError("denied", `No allow-list entry names the repository ${repo}; branches are only listed or removed in repositories the operator allow-listed.`);
  }
  return canonical;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ControlError) throw err;
    throw new ControlError("internal", `Could not read the repository's branches: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function branchesList({ service, allowlist, res, url }: BranchCall): Promise<void> {
  const raw = url.searchParams.get("repo");
  if (raw === null) throw invalid("Query parameter repo is required.", "repo");
  const repo = permittedRepo(allowlist(), raw, "repo");
  return sendJson(res, 200, "branches", await guarded(() => listBranches({ repo, lookup: (id) => service.getRun(id) })));
}

export async function branchesRemove({ service, allowlist, req, res }: BranchCall): Promise<void> {
  const body = await readJsonBody(req);
  checkBody("branches#remove_request", body);
  const request = body as RemoveRequest;
  const repo = permittedRepo(allowlist(), request.repo, "repo");
  return sendJson(res, 200, "branches#remove_response", await guarded(() => removeBranches({ repo, lookup: (id) => service.getRun(id) }, request.dry_run === true)));
}
