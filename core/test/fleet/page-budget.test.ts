// A member's events page fits the caller's cap: events of 100 000 three-byte characters could
// otherwise make a page of 50 pass 8 MiB, and that page would fail on every read.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { EventPage, RunEvent } from "../../src/contract/index.js";
import { MAX_PAGE_BYTES } from "../../src/fleet/remote-attach.js";
import { fitPage, PAGE_BUDGET_BYTES } from "../../src/fleet/serve-runs.js";

const RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";
const event = (cursor: number, text: string): RunEvent => ({ run_id: RUN, cursor, time: "2026-11-25T10:00:04Z", kind: "run.output", data: { channel: "text", text } }) as RunEvent;

test("a page of large events is cut to the budget, keeps a prefix and says there is more", () => {
  const events = Array.from({ length: 50 }, (_, i) => event(i + 1, "語".repeat(100_000)));
  const page: EventPage = { run_id: RUN, events, last_cursor: 50, more: false };
  assert.ok(Buffer.byteLength(JSON.stringify(page)) > MAX_PAGE_BYTES, "the uncut page would pass the cap");
  const cut = fitPage(page);
  assert.ok(PAGE_BUDGET_BYTES < MAX_PAGE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(cut)) <= PAGE_BUDGET_BYTES);
  assert.ok(cut.events.length >= 1 && cut.events.length < 50);
  assert.deepEqual(cut.events, events.slice(0, cut.events.length));
  assert.equal(cut.more, true);
  assert.equal(cut.last_cursor, 50);
});

test("a page within the budget is unchanged", () => {
  const page: EventPage = { run_id: RUN, events: [event(1, "short")], last_cursor: 1, more: false };
  assert.deepEqual(fitPage(page), page);
});
