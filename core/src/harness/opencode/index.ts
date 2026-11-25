/**
 * OpenCode v2 driver module. The worker loads it by path and calls `createDriver`; the options
 * are `OpenCodeDriverOptions`, written by the registry into the run's `driver.json`.
 */
import type { Driver, DriverContext } from "../../worker/driver.js";
import { capabilityDocument } from "../common/capabilities.js";
import { guardDriver } from "../common/guard.js";
import { RunDriver } from "../common/run-driver.js";
import { SandboxWorkspaceFactory, type SandboxSettings } from "../common/sandbox-workspace.js";
import { OpenCodeBackend, type OpenCodeSettings } from "./backend.js";
import { openCodeCore, OPENCODE_TRANSPORT } from "./capabilities.js";

export interface OpenCodeDriverOptions {
  sandbox: SandboxSettings;
  opencode: OpenCodeSettings;
  stopSettleMs?: number;
}

export function createDriver(context: DriverContext): Driver {
  const options = context.options as OpenCodeDriverOptions;
  const run = context.run;
  const driver = new RunDriver(new SandboxWorkspaceFactory(run.id, run.repo, options.sandbox), new OpenCodeBackend(options.opencode), {
    task: run.task,
    commitMessage: `run ${run.id}: changes by opencode`,
    ...(options.stopSettleMs === undefined ? {} : { stopSettleMs: options.stopSettleMs }),
    ...(options.sandbox.retainFailedSandboxDays === undefined ? {} : { retainFailedDays: options.sandbox.retainFailedSandboxDays }),
  });
  const doc = capabilityDocument({ harness: "opencode", available: true, version: null, transport: OPENCODE_TRANSPORT, core: openCodeCore() });
  return guardDriver(driver, doc);
}
