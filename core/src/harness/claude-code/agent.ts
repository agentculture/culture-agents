/**
 * The real agent factory: an AI SDK `HarnessAgent` running the Claude Code adapter in the run's
 * OpenShell sandbox. AI SDK types stay in this file.
 *
 * - `auth: {}`: the host forwards no credential. Without it the adapter looks for credentials
 *   on the host and forwards them into the sandbox (docs/d0/probe.md, "Credentials"). The bridge
 *   inherits the sandbox environment, where OpenShell's placeholder for
 *   CLAUDE_CODE_OAUTH_TOKEN is resolved by the proxy at egress.
 * - The sandbox session is passed to `createSession`, so the caller (the run driver) owns the
 *   sandbox's lifecycle; `session.destroy()` ends the bridge but never deletes the sandbox.
 * - `workDir` is the cloned repository, relative to the sandbox home.
 */
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";

import { toHarnessSandboxSession } from "../../sandbox/harness-session.js";
import type { ClaudeModel } from "../config.js";
import type { SandboxWorkspace } from "../common/sandbox-workspace.js";
import type { AgentFactory, AgentSessionLike } from "./backend.js";
import type { StreamPart } from "./map.js";

export const realAgentFactory: AgentFactory<SandboxWorkspace> = ({ workspace, model, onLog }) => {
  const agent = new HarnessAgent({
    harness: createClaudeCode({ auth: {} }),
    model: model as ClaudeModel,
    permissionMode: "allow-all",
    sandboxConfig: { workDir: workspace.relativeWorkdir },
    onLog: (d) => onLog(d.level, String(d.message)),
  });
  const sandboxSession = toHarnessSandboxSession(workspace.sandbox);
  return {
    createSession: ({ sessionId, abortSignal }) =>
      agent.createSession({ sessionId, sandboxSession, ...(abortSignal ? { abortSignal } : {}) }),
    stream: async ({ session, prompt, abortSignal }) => {
      const result = await agent.stream({ session: session as unknown as HarnessAgentSession, prompt, abortSignal });
      return { fullStream: result.fullStream as AsyncIterable<StreamPart> };
    },
  };
};

export type { AgentSessionLike };
