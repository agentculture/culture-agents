// Public, harness-neutral surface of the sandbox layer. Nothing exported here
// carries an AI SDK or OpenShell type. The harness adapter layer imports the
// AI-SDK-shaped session and provider from "./harness-session.js" instead.
import { connectOpenShell, type GatewayOptions } from "./openshell-client.js";
import { createRunSandboxes } from "./run-sandboxes.js";
import type { RunSandboxes, RunSandboxesConfig } from "./types.js";

export type {
  ExecOptions,
  ExecResult,
  PortEndpoint,
  RunProcess,
  RunSandbox,
  RunSandboxes,
  RunSandboxesConfig,
  RunSandboxState,
  SpawnOptions,
} from "./types.js";
export { SandboxBusyError, SandboxCleanupError, SandboxNotFoundError } from "./types.js";
export { InvalidRunIdError, runBranch, sandboxName, validateRunId } from "./naming.js";
export { PolicyError, DEFAULT_POLICY_PATH } from "./policy.js";
export {
  collect,
  HandoffError,
  prepare,
  type CollectedTree,
  type CollectOptions,
  type PreparedTree,
  type PrepareOptions,
} from "./worktree.js";
export type { CommandResult, CommandRunner, CommandOptions } from "./host-command.js";
export type { GatewayOptions } from "./openshell-client.js";

/** Connect to the OpenShell gateway and return run-scoped sandboxes on it. */
export async function openRunSandboxes(
  config: RunSandboxesConfig,
  gateway: GatewayOptions = {},
): Promise<RunSandboxes> {
  const client = await connectOpenShell(gateway);
  return createRunSandboxes(config, { client });
}
