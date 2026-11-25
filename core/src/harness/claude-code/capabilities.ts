/**
 * What Claude Code can do as this core drives it, measured live (core/test/harness/LIVE-RESULTS.md).
 * A capability that has not passed live is declared unsupported.
 */
import type { CapabilitySet } from "../../contract/index.js";
import { supported } from "../common/capabilities.js";

export const CLAUDE_CODE_TRANSPORT = "AI SDK HarnessAgent with the Claude Code adapter, bridged into an OpenShell sandbox";

export function claudeCodeCore(): Pick<CapabilitySet, "submit" | "stream" | "steer" | "cancel"> {
  return {
    submit: supported(
      "One turn per run. Changes the harness leaves uncommitted are committed by the core at the end and fetched to runs/<id>.",
    ),
    stream: supported("Text, reasoning and tool calls are streamed; tool results are clipped to 8000 characters."),
    steer: supported(
      "A steer is delivered as a user message into the running turn; the model decides how to act on it.",
      "A steer that arrives before the turn has started or after it ended is rejected, not queued.",
    ),
    cancel: supported(
      "Cancel aborts the turn, closes the bridge, force-kills any process the harness left, and deletes the sandbox.",
      "Work not yet committed when the run is cancelled is not collected.",
    ),
  };
}
