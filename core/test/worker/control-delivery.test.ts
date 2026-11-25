/**
 * Delivery semantics of the worker control channel, without a real worker process: the run
 * directory holds a real event log, and the "worker" is an in-process socket server that
 * misbehaves on purpose (drops the connection unread, drops it after reading, or is absent).
 *
 * The client must tell "the request never reached a live worker" from "the worker went away
 * after the action took effect", and answer from the run's log (the authoritative record), never
 * by retrying.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ActionRecord, Run, RunState } from "../../src/contract/index.js";
import { EventLogWriter } from "../../src/store/event-log.js";
import { RUN_FILES } from "../../src/store/files.js";
import { createRun } from "../../src/store/run-store.js";
import { ControlUnavailableError, closeControl, controlRequest, listenControl } from "../../src/worker/control.js";
import { WorkerControl } from "../../src/worker/spawn.js";
import { action, newRun, stateDir } from "./helpers.js";

/** A run directory whose log walks through `states`; `extra` adds events once the run is running. */
function runWithLog(t: TestContext, states: RunState[], extra: (run: Run) => { kind: "run.control" | "run.refused"; action: ActionRecord }[] = () => []) {
  const run: Run = newRun();
  const dir = createRun(stateDir(t), run);
  const writer = EventLogWriter.open(dir, run.id);
  for (const to of states) {
    writer.transition(to, null);
    if (to === "running") for (const e of extra(run)) writer.append({ kind: e.kind, data: { action: e.action } });
  }
  writer.close();
  return { run, dir };
}

type Misbehaviour = "drop-unread" | "drop-after-read";

/** A fake worker socket that never answers: it drops each connection unread or right after reading. */
async function fakeWorker(t: TestContext, dir: string, how: Misbehaviour): Promise<Server> {
  const server = createServer((socket: Socket) => {
    if (how === "drop-unread") {
      socket.destroy();
      return;
    }
    socket.once("data", () => socket.destroy());
  });
  server.listen(join(dir, RUN_FILES.socket));
  await once(server, "listening");
  t.after(() => server.close());
  return server;
}

test("a cancel the worker never read, on a run that already ended, is a conflict, not unavailable", async (t) => {
  const { run, dir } = runWithLog(t, ["queued", "running", "cancelling", "cancelled"]);
  await fakeWorker(t, dir, "drop-unread");
  const reply = await new WorkerControl(dir).cancel(action(run, "cancel"));
  assert.equal(reply.ok, false);
  assert.ok(!reply.ok && reply.error.code === "conflict" && reply.error.retryable === false);
  assert.ok(!reply.ok && reply.error.code === "conflict" && reply.error.run_id === run.id);
});

test("with the worker gone (no socket) after the run ended, steer, cancel and refuse answer conflict", async (t) => {
  const { run, dir } = runWithLog(t, ["queued", "running", "succeeded"]);
  rmSync(join(dir, RUN_FILES.socket), { force: true });
  const control = new WorkerControl(dir);
  const refused = { ...action(run, "steer", "refused"), error: { code: "conflict" as const, message: "Not running.", retryable: true, run_id: run.id } };
  for (const reply of [await control.steer(action(run, "steer"), "hi"), await control.cancel(action(run, "cancel")), await control.refuse(refused)]) {
    assert.ok(!reply.ok && reply.error.code === "conflict", JSON.stringify(reply));
  }
});

test("a steer whose reply was lost after the worker recorded it is reported accepted", async (t) => {
  let steer!: ActionRecord;
  const { dir } = runWithLog(t, ["queued", "running"], (run) => {
    steer = action(run, "steer");
    return [{ kind: "run.control", action: steer }];
  });
  await fakeWorker(t, dir, "drop-after-read");
  const reply = await new WorkerControl(dir).steer(steer, "hello");
  assert.equal(reply.ok, true, JSON.stringify(reply));
});

test("a worker that vanished with neither the action recorded nor a terminal state is unavailable", async (t) => {
  const { run, dir } = runWithLog(t, ["queued", "running"]);
  await fakeWorker(t, dir, "drop-after-read");
  await assert.rejects(new WorkerControl(dir).cancel(action(run, "cancel")), ControlUnavailableError);
  rmSync(join(dir, RUN_FILES.socket), { force: true });
  await assert.rejects(new WorkerControl(dir).steer(action(run, "steer"), "x"), ControlUnavailableError);
});

test("closing the control server delivers the reply to a request already being handled", async (t) => {
  const dir = stateDir(t);
  let entered!: () => void;
  const inHandler = new Promise<void>((resolve) => (entered = resolve));
  const server = await listenControl(dir, async () => {
    entered();
    await delay(150);
    return { ok: true, pid: process.pid, state: "cancelled", cursor: 4 };
  });
  const reply = controlRequest(dir, { op: "ping" });
  await inHandler;
  const closed = closeControl(dir, server);
  const got = await reply;
  assert.deepEqual(got, { ok: true, pid: process.pid, state: "cancelled", cursor: 4 });
  await closed;
});

test("an idle connection cannot hold the control server open past the close grace", async (t) => {
  const dir = stateDir(t);
  const server = await listenControl(dir, () => ({ ok: true, pid: process.pid, state: null, cursor: 0 }));
  const { createConnection } = await import("node:net");
  const idle = createConnection(join(dir, RUN_FILES.socket));
  idle.on("error", () => undefined);
  await once(idle, "connect");
  t.after(() => idle.destroy());
  const started = Date.now();
  await closeControl(dir, server, { graceMs: 200 });
  assert.ok(Date.now() - started < 2000, "close did not wait for the idle client");
});
