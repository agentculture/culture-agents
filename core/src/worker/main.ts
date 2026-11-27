/**
 * Worker process entry point. The daemon spawns it detached (own session, stdio to the run's
 * `worker.log`, no IPC channel), so it survives the daemon:
 *
 *   node dist/src/worker/main.js --state-dir <dir> --run-id <id> [--heartbeat-ms N] [--cancel-grace-ms N] [--question-limit-ms N]
 *
 * Exit 0 once the run is terminal; exit 1 when the run could not be opened (nothing is
 * acknowledged then, and the run stays without a live worker).
 */
import { parseArgs } from "node:util";

import { isRunId } from "../contract/index.js";
import { runWorker } from "./run-loop.js";

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      "run-id": { type: "string" },
      "heartbeat-ms": { type: "string" },
      "cancel-grace-ms": { type: "string" },
      "question-limit-ms": { type: "string" },
    },
    strict: true,
  });
  const stateDir = values["state-dir"];
  const runId = values["run-id"];
  if (!stateDir || !runId || !isRunId(runId)) throw new Error("usage: main.js --state-dir <dir> --run-id <run id>");
  // The worker outlives the daemon and any terminal: a hangup is not a reason to stop.
  process.on("SIGHUP", () => undefined);
  const heartbeatMs = positiveInt(values["heartbeat-ms"], "heartbeat-ms");
  const cancelGraceMs = positiveInt(values["cancel-grace-ms"], "cancel-grace-ms");
  const questionLimitMs = positiveInt(values["question-limit-ms"], "question-limit-ms");
  const state = await runWorker({
    stateDir,
    runId,
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
    ...(questionLimitMs === undefined ? {} : { questionLimitMs }),
  });
  process.stderr.write(`worker ${process.pid}: run ${runId} ended ${state}\n`);
  return 0;
}

let exitCode: number;
try {
  exitCode = await main();
} catch (err) {
  process.stderr.write(`worker ${process.pid}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  exitCode = 1;
}
process.exit(exitCode);
