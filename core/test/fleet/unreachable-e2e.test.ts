// t25 with two real cores: thor's core process is halted (SIGSTOP: the host stops answering, the
// kernel still accepts connections), its worker is killed meanwhile, and the caller reads the run
// as unreachable on every read, never as a state. The caller's directory and thor's run directories
// are byte-identical across the reads, so the caller wrote nothing and nobody wrote `unknown`.
// When thor resumes, the owning core alone writes `unknown`, with its evidence, and the caller's
// next read shows that true terminal state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validate, type RemoteSubmitResponse, type RunView } from "../../src/contract/index.js";
import { call } from "../daemon/harness.js";
import { HANG, killWorkers, waitFor, waitRun } from "../runs/support.js";
import { CALLER_NODE, submitBody } from "./remote-support.js";
import { twoCores } from "./two-cores.js";

const CALLER = { kind: "operator", id: `${CALLER_NODE}-operator` } as const;

/** Every regular file under `dir` with a digest of its content. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = statSync(path, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(path);
      else if (st?.isFile()) out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

test("two real cores: a halted host's run reads unreachable on every read, nothing is written by the caller, and the true state shows when it answers again", async (t) => {
  const { thor, caller, thorDaemon } = await twoCores(t);
  const reply = await call(caller.socket, "POST", "/v1/fleet/runs", { body: { ...submitBody({ harness: HANG.id, deadline_ms: 600_000 }), caller: CALLER } });
  assert.equal(reply.status, 201, reply.text);
  const { run } = reply.json as RemoteSubmitResponse;
  await waitRun(thor, run.id, (r) => r.state === "running", "the run to start on thor");
  const read = async (): Promise<RunView> => {
    const r = await call(caller.socket, "GET", `/v1/fleet/runs/${run.id}/view`);
    assert.equal(r.status, 200, r.text);
    assert.ok(validate("reachability", r.json).ok, r.text);
    return r.json as RunView;
  };
  const first = await read();
  assert.deepEqual([first.view, first.run?.state], ["reachable", "running"]);

  const pid = thorDaemon.proc.pid ?? 0;
  process.kill(pid, "SIGSTOP");
  t.after(() => {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // gone
    }
  });
  killWorkers(thor); // the worker is gone while the core cannot notice
  const callerBefore = tree(caller.root);
  const thorBefore = tree(thor.stateDir);
  const started = Date.now();
  const reads: RunView[] = [await read(), await read()];
  assert.ok(Date.now() - started < 12_000, "each read ends within the 5 s call timeout");
  assert.deepEqual(reads.map((r) => r.view), ["unreachable", "unreachable"]);
  assert.equal(reads.filter((r) => r.run !== undefined).length, 0, "0 reads succeeded");
  assert.equal(JSON.stringify(reads).includes("succeeded"), false);
  assert.deepEqual(tree(caller.root), callerBefore, "the caller wrote nothing");
  assert.deepEqual(tree(thor.stateDir), thorBefore, "no run directory of the owner changed while it was halted: no `unknown` from the caller's side");

  process.kill(pid, "SIGCONT");
  const settled = await waitRun(thor, run.id, (r) => r.terminal, "the owning core to record the end", 20_000);
  assert.equal(settled.state, "unknown", "written by the owning core, on the evidence that the worker is gone");
  await waitFor(async () => (await read()).view === "reachable", 20_000, "the caller to reach thor again");
  const healed = await read();
  assert.deepEqual([healed.run?.state, healed.run?.terminal], ["unknown", true], "the true terminal state, never `unreachable` and never `succeeded`");
});
