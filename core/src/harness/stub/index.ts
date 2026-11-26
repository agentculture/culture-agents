/**
 * The stub harness driver module: the shared run driver over a host temp clone and an
 * in-process harness. It imports no AI SDK, OpenShell or vendor package (a test walks its import
 * graph), so swapping it in for a real harness proves the rest of the system is harness-neutral.
 */
import type { CapabilitySet } from "../../contract/index.js";
import type { Driver, DriverContext } from "../../worker/driver.js";
import { capabilityDocument, supported } from "../common/capabilities.js";
import { guardDriver } from "../common/guard.js";
import { RunDriver } from "../common/run-driver.js";
import { StubBackend } from "./backend.js";
import { StubWorkspaceFactory } from "./workspace.js";

export interface StubDriverOptions {
  ref: string;
  identity: { name: string; email: string };
  stepMs?: number;
}

export const STUB_TRANSPORT = "in-process stub harness over a host temp clone (no sandbox, no vendor code)";

export function stubCore(): Pick<CapabilitySet, "submit" | "stream" | "steer" | "cancel"> {
  return {
    submit: supported("A deterministic stand-in for tests; it writes the files a task names."),
    stream: supported(),
    steer: supported("A steer with `files: ...` replaces the files not yet written."),
    cancel: supported(),
  };
}

/** The stub has no sandbox: its clone per run is a temporary directory on the host, still never a worktree. */
export const STUB_ISOLATION = supported(
  "Each run works in its own temporary clone of the repository on the host (the stub has no sandbox), made from the commit recorded at submit, and its commits return only to its own runs/<run_id> branch. No git worktree is created, and the host checkout and index are never written.",
);

export function createDriver(context: DriverContext): Driver {
  const options = context.options as StubDriverOptions;
  const run = context.run;
  const driver = new RunDriver(
    new StubWorkspaceFactory(run.id, run.repo, { ref: run.base_commit ?? options.ref, identity: options.identity }),
    new StubBackend(options.stepMs === undefined ? {} : { stepMs: options.stepMs }),
    { task: run.task, commitMessage: `run ${run.id}: changes by stub`, processSettleMs: 0 },
  );
  return guardDriver(driver, capabilityDocument({ harness: "stub", available: true, version: "stub-1", transport: STUB_TRANSPORT, core: stubCore(), isolation: STUB_ISOLATION }));
}
