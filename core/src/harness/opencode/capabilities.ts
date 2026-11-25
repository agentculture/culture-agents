/**
 * What OpenCode v2 can do as this core drives it (its own server API, in an OpenShell sandbox),
 * measured live (core/test/harness/LIVE-RESULTS.md). A capability that has not passed live is
 * declared unsupported.
 */
import type { CapabilitySet } from "../../contract/index.js";
import { supported } from "../common/capabilities.js";

export const OPENCODE_TRANSPORT = "OpenCode v2 server API (opencode serve) in an OpenShell sandbox, over a forwarded port";

export function openCodeCore(): Pick<CapabilitySet, "submit" | "stream" | "steer" | "cancel"> {
  return {
    submit: supported(
      "One turn per run. Changes the harness leaves uncommitted are committed by the core at the end and fetched to runs/<id>.",
      "Turn completion is taken from the server's wait and session routes, not from the event stream.",
    ),
    stream: supported(
      "The server's event stream is volatile: output emitted while it is disconnected is lost (the gap is reported as a diagnostic).",
    ),
    steer: supported(
      "A steer is a prompt with delivery `steer` into the running execution; the model decides how to act on it.",
      "A steer that arrives before the turn has started or after it ended is rejected, not queued.",
    ),
    cancel: supported(
      "Cancel interrupts the execution, stops the server, force-kills any process left behind (OpenCode's interrupt does not always end a tool's child process), and deletes the sandbox.",
      "Work not yet committed when the run is cancelled is not collected.",
    ),
  };
}
