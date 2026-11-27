// The remote attach stream against a fake member: pages are written in order, a member with nothing
// new is asked again after the poll pause, and the stream stops asking once the client leaves.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";

import type { EventPage, RunEvent } from "../../src/contract/index.js";
import { streamRemoteAttach } from "../../src/fleet/remote-attach.js";
import type { Remote, RemoteRequest } from "../../src/fleet/remote.js";

const RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";

const text = (cursor: number): RunEvent => ({ run_id: RUN, cursor, time: "2026-11-25T10:00:04Z", kind: "run.output", data: { channel: "text", text: `line ${cursor}` } }) as RunEvent;

/** A response that records what was written, and can be closed like a client that left. */
class FakeResponse extends EventEmitter {
  frames: string[] = [];
  writableEnded = false;
  writeHead(): this {
    return this;
  }
  flushHeaders(): void {}
  write(chunk: string): boolean {
    if (!chunk.startsWith(":")) this.frames.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
}

/** Whether `ready` holds within `ms`, checked every 5 ms. */
function until(ready: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!ready() && Date.now() - started < ms) return;
      clearInterval(timer);
      resolve(ready());
    }, 5);
  });
}

/** A member whose pages come from `pages` in order; once they run out it answers empty pages. */
function member(pages: EventPage[]): { remote: Remote; asked: number[] } {
  const asked: number[] = [];
  const remote: Remote = {
    apiVersion: "3.3",
    request: (_node: string, r: RemoteRequest) => {
      const after = Number(new URL(r.path, "https://fleet.invalid").searchParams.get("after"));
      asked.push(after);
      return Promise.resolve(pages.shift() ?? { run_id: RUN, events: [], last_cursor: after, more: false });
    },
    fetchBytes: () => Promise.reject(new Error("not used")),
  };
  return { remote, asked };
}

test("pages are written in order, a member with nothing new is asked again, and a client that leaves stops the asking", async () => {
  const { remote, asked } = member([
    { run_id: RUN, events: [text(1), text(2)], last_cursor: 2, more: true },
    { run_id: RUN, events: [text(3)], last_cursor: 3, more: false },
  ]);
  const res = new FakeResponse();
  const streaming = streamRemoteAttach({ remote, node: "thor", runId: RUN, after: 0, res: res as unknown as ServerResponse, keepaliveMs: 60_000, shutdown: new AbortController().signal, pollMs: 10 }, () => undefined);
  assert.ok(await until(() => asked.length >= 5, 5000), "the member was asked again while it had nothing new");
  assert.deepEqual(asked.slice(0, 3), [0, 2, 3], "each page is asked for after the last cursor written");
  res.emit("close"); // the client left
  await streaming;
  const after = asked.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(asked.length, after, "nothing is asked once the client left");
  assert.equal(res.frames.length, 3);
  assert.ok(res.frames.every((f, i) => f.includes(`line ${i + 1}`)));
  assert.ok(res.writableEnded);
});

test("a terminal event ends the stream without asking again", async () => {
  const terminal = { run_id: RUN, cursor: 2, time: "2026-11-25T10:00:05Z", kind: "run.state", data: { from: "running", to: "succeeded", reason: null } } as RunEvent;
  const { remote, asked } = member([{ run_id: RUN, events: [text(1), terminal], last_cursor: 2, more: false }]);
  const res = new FakeResponse();
  await streamRemoteAttach({ remote, node: "thor", runId: RUN, after: 0, res: res as unknown as ServerResponse, keepaliveMs: 60_000, shutdown: new AbortController().signal, pollMs: 10 }, () => undefined);
  assert.deepEqual(asked, [0]);
  assert.equal(res.frames.length, 2);
  assert.ok(res.writableEnded);
});
