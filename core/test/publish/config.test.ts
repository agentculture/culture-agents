/** Publishing is off unless a broker address is configured, and only a loopback address is accepted. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BROKER_URL_ENV, PublishConfigError, loadPublishConfig, startPublishing } from "../../src/publish/index.js";

const load = (value: string | undefined) => loadPublishConfig(value === undefined ? {} : { [BROKER_URL_ENV]: value });

test("without a configured address publishing is off", async () => {
  assert.equal(BROKER_URL_ENV, "CULTURE_AGENTS_BROKER_URL");
  assert.equal(load(undefined), null);
  assert.equal(load(""), null);
  assert.equal(load("   "), null);
  const lines: string[] = [];
  assert.equal(await startPublishing({ stateDir: "/nonexistent", node: "thor", env: {}, log: (line) => void lines.push(line) }), null);
  assert.deepEqual(lines, [], "off is the default and says nothing");
});

test("a loopback mqtt address is accepted; the port defaults to 1883", () => {
  assert.deepEqual(load("mqtt://127.0.0.1:1883"), { url: "mqtt://127.0.0.1:1883", host: "127.0.0.1", port: 1883 });
  assert.deepEqual(load("mqtt://127.0.0.1"), { url: "mqtt://127.0.0.1:1883", host: "127.0.0.1", port: 1883 });
  assert.deepEqual(load(" mqtt://localhost:18830/ "), { url: "mqtt://localhost:18830", host: "localhost", port: 18830 });
  assert.deepEqual(load("mqtt://127.0.0.5:1884"), { url: "mqtt://127.0.0.5:1884", host: "127.0.0.5", port: 1884 });
  assert.deepEqual(load("mqtt://[::1]:1883"), { url: "mqtt://[::1]:1883", host: "::1", port: 1883 });
});

test("anything else is refused with a message that names the variable", () => {
  for (const value of [
    "127.0.0.1:1883",
    "http://127.0.0.1:1883",
    "mqtts://127.0.0.1:8883",
    "ws://127.0.0.1:9001",
    "mqtt://broker.example:1883",
    "mqtt://192.0.2.10:1883",
    "mqtt://0.0.0.0:1883",
    "mqtt://127.0.0.1:1883/topic",
    "mqtt://127.0.0.1:1883?x=1",
    "mqtt://127.0.0.1:0",
    "mqtt://127.0.0.1:99999",
    "mqtt://",
  ]) {
    assert.throws(() => load(value), (err) => err instanceof PublishConfigError && err.message.includes(BROKER_URL_ENV), value);
  }
});

test("a user name or password is refused and never repeated", () => {
  const secret = "s3cr3t-value";
  assert.throws(
    () => load(`mqtt://operator:${secret}@127.0.0.1:1883`),
    (err) => err instanceof PublishConfigError && !err.message.includes(secret) && !err.message.includes("operator"),
  );
});

test("a value that cannot be used leaves publishing off and says so in one line; the core is not stopped", async () => {
  const lines: string[] = [];
  const publisher = await startPublishing({ stateDir: "/nonexistent", node: "thor", env: { [BROKER_URL_ENV]: "mqtt://broker.example:1883" }, log: (line) => void lines.push(line) });
  assert.equal(publisher, null);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /run events are not published: CULTURE_AGENTS_BROKER_URL must name a loopback address/);
});
