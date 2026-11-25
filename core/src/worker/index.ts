/**
 * The per-run worker: a separate OS process that drives one run through a harness `Driver`,
 * owns the run's event log while it lives, enforces the deadline, and survives the daemon.
 * The daemon starts it with `spawnWorker` and reaches it with `WorkerControl` /
 * `reconnectWorker`. The entry point (`main.js`) is not exported: it is run as a process.
 */
export { ControlUnavailableError, controlRequest, parseRequest } from "./control.js";
export type { ControlHandler, ControlReply, ControlRequest } from "./control.js";
export type { Driver, DriverContext, DriverEvent, DriverFactory, DriverSelection } from "./driver.js";
export { FakeDriver, createDriver as createFakeDriver } from "./fake-driver.js";
export type { FakeDriverOptions, FakeStep } from "./fake-driver.js";
export { RunWorker, runWorker } from "./run-loop.js";
export type { WorkerOptions } from "./run-loop.js";
export { WORKER_ENTRY, WorkerControl, WorkerSpawnError, reconnectWorker, spawnWorker } from "./spawn.js";
export type { Reconnect, SpawnWorkerOptions, SpawnedWorker } from "./spawn.js";
