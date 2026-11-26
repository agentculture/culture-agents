/**
 * Contract-level tests every harness driver must pass, unchanged, whatever runs behind it: the
 * stub (unit suite) and Claude Code and OpenCode (live suite). Each declared capability gets a
 * behavioural test; each undeclared one a refusal test that proves the action is not forwarded.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { CapabilityName, Run } from "../../src/contract/index.js";
import { UnsupportedCapabilityError, type ControlCapability, type GuardedDriver } from "../../src/harness/index.js";
import type { StopReport } from "../../src/harness/common/types.js";
import type { Driver, DriverEvent } from "../../src/worker/driver.js";
import { branchFiles, drive, hostRepo, lastEvent, newRun, outputs } from "./helpers.js";

export interface ContractTarget {
  harness: string;
  /** Why the suite cannot run here (reported as NOT VERIFIED, a skip); null to run. */
  skip: () => Promise<string | null>;
  createDriver(run: Run, label: string): Promise<GuardedDriver>;
  submit: { task: string; expectFiles: string[] };
  steer: { task: string; afterToolResults: number; message: string; expectFiles: string[]; forbidFiles: string[] };
  cancel: { task: string; afterToolCalls: number; delayMs: number };
  /** Extra checks after a cancel (live: the sandbox is gone). */
  afterCancel?(run: Run): Promise<void>;
  /** Called with every finished run (live: records results). */
  record?(entry: { capability: string; trial: number; run: Run; events: DriverEvent[]; ok: boolean; note: string }): void;
  trials: number;
  timeoutMs: number;
}

const CONTROL: ControlCapability[] = ["steer", "cancel", "pause", "resume", "answer"];

function notVerified(t: TestContext, reason: string): void {
  const line = `NOT VERIFIED: ${reason}`;
  console.log(line);
  t.skip(line);
}

function hostUnchanged(git: (...a: string[]) => string, status: string): void {
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main", "the host branch is unchanged");
  assert.equal(git("status", "--porcelain"), status, "the host status is unchanged");
}

function stopReport(driver: GuardedDriver): StopReport | null {
  return (driver.inner as Driver & { stopReport?: StopReport | null }).stopReport ?? null;
}

function cancelNote(report: StopReport | null, listed: boolean): string {
  if (!report) return "no stop report";
  const counts = `after interrupt ${report.afterInterrupt.length} new process(es), after close ${report.afterClose.length}, killed ${report.killed.length}, remaining ${report.remaining.length}, destroyed ${report.destroyed}`;
  return listed ? counts : `${counts}; LISTING FAILED: ${JSON.stringify(report.listingFailed)}`;
}

/**
 * Registers the suite's tests (synchronously, in order) and resolves when they have all run, so
 * the test file awaits them rather than leaving their promises floating.
 */
export async function defineContractSuite(target: ContractTarget): Promise<void> {
  const registered: Promise<void>[] = [];
  const define = (title: string, options: { timeout?: number }, fn: (t: TestContext) => Promise<void>): void => {
    registered.push(test(title, options, fn));
  };
  const name = (what: string, trial: number) => {
    const suffix = target.trials > 1 ? ` (trial ${trial})` : "";
    return `${target.harness}: ${what}${suffix}`;
  };
  for (let trial = 1; trial <= target.trials; trial++) {
    define(name("submit completes, streams output, and its commit arrives on runs/<id>", trial), { timeout: target.timeoutMs }, async (t) => {
      const why = await target.skip();
      if (why) return notVerified(t, why);
      const { dir, git } = hostRepo(t);
      const status = git("status", "--porcelain");
      const run = newRun(dir, target.submit.task, target.harness);
      const driver = await target.createDriver(run, `submit-${trial}`);
      let events: DriverEvent[] = [];
      try {
        events = await drive(driver.start());
      } finally {
        await driver.dispose();
      }
      const files = branchFiles(git, run.id);
      const ok = lastEvent(events)?.type === "completed" && target.submit.expectFiles.every((f) => files?.includes(f));
      target.record?.({ capability: "submit+stream", trial, run, events, ok, note: `files ${files?.join(" ") ?? "(no branch)"}` });
      assert.equal(events[0]?.type, "started", "the first event is started");
      assert.equal(lastEvent(events)?.type, "completed", `the run completes: ${JSON.stringify(lastEvent(events))}`);
      assert.equal(events.filter((e) => e.type === "completed" || e.type === "failed" || e.type === "stopped").length, 1, "exactly one outcome");
      const streamed = outputs(events).filter((d) => d.channel !== "diagnostic");
      assert.ok(streamed.length > 0, "harness output is streamed before the outcome");
      for (const f of target.submit.expectFiles) assert.ok(files?.includes(f), `runs/<id> has ${f} (files: ${files?.join(" ")})`);
      hostUnchanged(git, status);
    });

    define(name("steer changes the outcome", trial), { timeout: target.timeoutMs }, async (t) => {
      const why = await target.skip();
      if (why) return notVerified(t, why);
      const { dir, git } = hostRepo(t);
      const status = git("status", "--porcelain");
      const run = newRun(dir, target.steer.task, target.harness);
      const driver = await target.createDriver(run, `steer-${trial}`);
      let steered = false;
      let steerError: unknown = null;
      const refusals: string[] = [];
      let events: DriverEvent[] = [];
      try {
        events = await drive(driver.start(), async (_e, seen) => {
          if (steered || outputs(seen, "tool_result").length < target.steer.afterToolResults) return;
          steered = true;
          // Undeclared controls mid-run: refused, not forwarded, and the run carries on.
          const undeclared = CONTROL.filter((action) => !driver.capabilities.capabilities[action].supported);
          await Promise.all(
            undeclared.map((action) =>
              assert.rejects(driver.control(action), (err: unknown) => err instanceof UnsupportedCapabilityError && err.capability === action),
            ),
          );
          refusals.push(...undeclared);
          await driver.steer(target.steer.message).catch((err: unknown) => (steerError = err));
        });
      } finally {
        await driver.dispose();
      }
      const files = branchFiles(git, run.id) ?? [];
      const ok =
        steered &&
        steerError === null &&
        lastEvent(events)?.type === "completed" &&
        target.steer.expectFiles.every((f) => files.includes(f)) &&
        !target.steer.forbidFiles.some((f) => files.includes(f));
      target.record?.({ capability: "steer", trial, run, events, ok, note: `files ${files.join(" ")}; refused mid-run: ${refusals.join(",") || "none"}` });
      assert.ok(steered, "the steer was sent");
      assert.equal(steerError, null, `the steer was accepted: ${String(steerError)}`);
      assert.equal(lastEvent(events)?.type, "completed", `the run completes: ${JSON.stringify(lastEvent(events))}`);
      for (const f of target.steer.expectFiles) assert.ok(files.includes(f), `runs/<id> has ${f} (files: ${files.join(" ")})`);
      for (const f of target.steer.forbidFiles) assert.ok(!files.includes(f), `runs/<id> lacks ${f} (files: ${files.join(" ")})`);
      hostUnchanged(git, status);
    });

    define(name("cancel stops the run, leaves no process, and releases the workspace", trial), { timeout: target.timeoutMs }, async (t) => {
      const why = await target.skip();
      if (why) return notVerified(t, why);
      const { dir, git } = hostRepo(t);
      const status = git("status", "--porcelain");
      const run = newRun(dir, target.cancel.task, target.harness);
      const driver = await target.createDriver(run, `cancel-${trial}`);
      let cancelled = false;
      let events: DriverEvent[] = [];
      try {
        events = await drive(driver.start(), (_e, seen) => {
          if (cancelled || outputs(seen, "tool_call").length < target.cancel.afterToolCalls) return;
          cancelled = true;
          setTimeout(() => void driver.cancel("contract test"), target.cancel.delayMs);
        });
      } finally {
        await driver.dispose();
      }
      const report = stopReport(driver);
      const listed = report !== null && Object.keys(report.listingFailed).length === 0;
      const ok = lastEvent(events)?.type === "stopped" && report !== null && listed && report.remaining.length === 0 && report.destroyed;
      target.record?.({
        capability: "cancel",
        trial,
        run,
        events,
        ok,
        note: cancelNote(report, listed),
      });
      assert.ok(cancelled, "the cancel was sent");
      assert.equal(lastEvent(events)?.type, "stopped", `the run stops: ${JSON.stringify(lastEvent(events))}`);
      assert.ok(report, "the driver reports what the stop found");
      assert.deepEqual(report.listingFailed, {}, "every process check could look; an empty list is not a failed listing");
      assert.deepEqual(report.remaining, [], "no harness or tool process is left");
      assert.equal(report.destroyed, true, "the workspace is destroyed");
      await target.afterCancel?.(run);
      hostUnchanged(git, status);
    });
  }

  define(`${target.harness}: every undeclared capability is refused with unsupported and not forwarded`, {}, async (t) => {
    const { dir } = hostRepo(t);
    const run = newRun(dir, target.submit.task, target.harness);
    const driver = await target.createDriver(run, "refusal");
    const caps = driver.capabilities.capabilities;
    const undeclared = (Object.keys(caps) as CapabilityName[]).filter((c) => !caps[c].supported);
    assert.ok(undeclared.length >= 6, "at least the deferred capabilities and answer are undeclared (worktree_isolation is supported since t8)");
    let forwarded = 0;
    const inner = driver.inner as Driver;
    const original = { steer: inner.steer.bind(inner), cancel: inner.cancel.bind(inner) };
    inner.steer = async (m) => {
      forwarded += 1;
      return original.steer(m);
    };
    inner.cancel = async (r) => {
      forwarded += 1;
      return original.cancel(r);
    };
    await Promise.all(
      CONTROL.filter((a) => !caps[a].supported).map((action) =>
        assert.rejects(driver.control(action, "x"), (err: unknown) => {
          assert.ok(err instanceof UnsupportedCapabilityError);
          assert.equal(err.body.code, "unsupported");
          assert.equal(err.capability, action);
          return true;
        }),
      ),
    );
    assert.equal(forwarded, 0, "no refused action reached the driver");
    await driver.dispose();
  });
  await Promise.all(registered);
}
