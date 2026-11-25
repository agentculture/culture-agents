/**
 * Live contract suite for the real harnesses: Claude Code (AI SDK adapter) and OpenCode v2 (its
 * server API), each in a real OpenShell sandbox with real model calls. It spends model turns, so
 * it runs only when CULTURE_AGENTS_LIVE_HARNESS=1; otherwise, or when the gateway, run image or
 * providers are unavailable, every check is reported NOT VERIFIED (a skip, never a pass).
 *
 *   CULTURE_AGENTS_LIVE_HARNESS=1           opt in (each run is one harness turn)
 *   CULTURE_AGENTS_LIVE_HARNESSES=a,b       which harnesses (default claude-code,opencode)
 *   CULTURE_AGENTS_LIVE_TRIALS=N            repetitions of each check (default 1)
 *   CULTURE_AGENTS_LIVE_TAP_DIR=dir         record raw harness events per run (fixtures)
 *   CULTURE_AGENTS_LIVE_RESULTS=file        append one JSON line per run
 * plus the harness configuration (src/harness/config.ts), e.g. CULTURE_AGENTS_SANDBOX_PREFIX.
 * Uses temporary host repos only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Run } from "../../src/contract/index.js";
import { getHarness, loadHarnessConfig, type GuardedDriver, type HarnessEntry } from "../../src/harness/index.js";
import { sandboxName } from "../../src/sandbox/index.js";
import type { DriverFactory } from "../../src/worker/driver.js";
import { defineContractSuite, type ContractTarget } from "./contract-suite.js";

const config = loadHarnessConfig();
const enabled = process.env["CULTURE_AGENTS_LIVE_HARNESS"] === "1";
const wanted = (process.env["CULTURE_AGENTS_LIVE_HARNESSES"] ?? "claude-code,opencode").split(",").map((s) => s.trim());
const trials = Number(process.env["CULTURE_AGENTS_LIVE_TRIALS"] ?? "1");
const tapDir = process.env["CULTURE_AGENTS_LIVE_TAP_DIR"];
const resultsFile = process.env["CULTURE_AGENTS_LIVE_RESULTS"];

const availability = new Map<string, Promise<string | null>>();
function skipReason(entry: HarnessEntry): Promise<string | null> {
  if (!enabled) return Promise.resolve(`live harness turns are opt-in: set CULTURE_AGENTS_LIVE_HARNESS=1 (${entry.id})`);
  let check = availability.get(entry.id);
  if (!check) {
    check = entry.capabilities().then((doc) =>
      doc.available ? null : `${entry.id} unavailable: ${JSON.stringify((doc.extension as { unavailable?: unknown } | undefined)?.unavailable)}`,
    );
    availability.set(entry.id, check);
  }
  return check;
}

function withTap(entry: HarnessEntry, label: string): Record<string, unknown> {
  if (!tapDir) return entry.driver.options;
  mkdirSync(tapDir, { recursive: true });
  const tap = join(tapDir, `${entry.id}-${label}-${Date.now()}.ndjson`);
  const options = structuredClone(entry.driver.options);
  if (entry.id === "opencode") (options["opencode"] as Record<string, unknown>)["tap"] = tap;
  else options["tap"] = tap;
  return options;
}

function sandboxGone(run: Run): void {
  const name = sandboxName(run.id, config.sandboxPrefix);
  const gw = config.gateway.name ? ["-g", config.gateway.name] : [];
  let present = true;
  try {
    execFileSync(config.openshellBin, [...gw, "sandbox", "get", name], { stdio: "pipe" });
  } catch {
    present = false;
  }
  assert.equal(present, false, `sandbox ${name} is deleted`);
}

const TASKS: Record<string, Pick<ContractTarget, "submit" | "steer" | "cancel">> = {
  "claude-code": {
    submit: {
      task: "Create a file named hello.txt containing the word hi, using your Write tool. Then reply with the single word done.",
      expectFiles: ["hello.txt"],
    },
    steer: {
      task:
        "Create ten files named file01.txt to file10.txt in the current directory, ONE AT A TIME with a separate Write tool call " +
        "each (never in parallel, never via Bash). Each file contains just its number. Do not explain.",
      afterToolResults: 2,
      message: "Change of plan: stop creating numbered files now. Do not create any more of them. Instead create a file named STEERED.txt containing the word steered, then finish.",
      expectFiles: ["file01.txt", "file02.txt", "STEERED.txt"],
      forbidFiles: ["file10.txt"],
    },
    cancel: { task: "Run the shell command: sleep 120 && echo late > late.txt . Use the Bash tool. Then write done.txt.", afterToolCalls: 1, delayMs: 3000 },
  },
  opencode: {
    submit: {
      task: "Create a file named hello.txt containing the word hi, using your write tool. Then reply with the single word done.",
      expectFiles: ["hello.txt"],
    },
    steer: {
      task:
        "Run these six shell commands ONE AT A TIME, each as its own separate bash tool call, never in parallel: " +
        "sleep 3 && echo 1 > file1.txt ; sleep 3 && echo 2 > file2.txt ; sleep 3 && echo 3 > file3.txt ; " +
        "sleep 3 && echo 4 > file4.txt ; sleep 3 && echo 5 > file5.txt ; sleep 3 && echo 6 > file6.txt . Then reply done.",
      afterToolResults: 2,
      message: "Change of plan: do not create any more numbered files. Instead create a file named STEERED.txt containing the word steered, then reply done.",
      expectFiles: ["file1.txt", "file2.txt", "STEERED.txt"],
      forbidFiles: ["file6.txt"],
    },
    cancel: {
      task: "Run the shell command: sleep 120 && echo late > late.txt . Use one bash tool call in the foreground. Then create done.txt.",
      afterToolCalls: 1,
      delayMs: 3000,
    },
  },
};

test("every harness with live tasks is in the registry", () => {
  for (const id of Object.keys(TASKS)) assert.ok(getHarness(config, id), `registry lists ${id}`);
});

const suites: Promise<void>[] = [];
for (const id of ["claude-code", "opencode"]) {
  if (!wanted.includes(id)) continue;
  const entry = getHarness(config, id);
  if (!entry) continue; // the test above fails for a harness the registry does not list
  const tasks = TASKS[id] as Pick<ContractTarget, "submit" | "steer" | "cancel">;
  const target: ContractTarget = {
    harness: id,
    skip: () => skipReason(entry),
    createDriver: async (run, label) => {
      const mod = (await import(entry.driver.module)) as { createDriver: DriverFactory };
      return (await mod.createDriver({ run, runDir: run.repo, options: withTap(entry, label) })) as GuardedDriver;
    },
    ...tasks,
    afterCancel: async (run) => sandboxGone(run),
    record: (r) => {
      const line = {
        harness: id,
        capability: r.capability,
        trial: r.trial,
        ok: r.ok,
        note: r.note,
        run: r.run.id,
        outcome: r.events[r.events.length - 1],
        outputs: r.events.filter((e) => e.type === "output").length,
      };
      console.log(`LIVE ${JSON.stringify(line)}`);
      if (resultsFile) appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
    },
    trials,
    timeoutMs: 360_000,
  };
  suites.push(defineContractSuite(target));
}
await Promise.all(suites);
