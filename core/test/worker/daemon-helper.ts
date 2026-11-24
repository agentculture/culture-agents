/**
 * A stand-in "daemon" process for tests: it spawns one worker through the real spawner, prints
 * `{"pid": <worker pid>, "runDir": ...}` once the spawn resolves, then idles until killed.
 * Usage: node daemon-helper.js '<json SpawnWorkerOptions>'
 */
import { spawnWorker, type SpawnWorkerOptions } from "../../src/worker/spawn.js";

const options = JSON.parse(process.argv[2] ?? "{}") as SpawnWorkerOptions;
const worker = await spawnWorker(options);
process.stdout.write(`${JSON.stringify({ pid: worker.pid, runDir: worker.runDir, daemon: process.pid })}\n`);
setInterval(() => undefined, 60_000);
