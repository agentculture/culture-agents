/**
 * A throwaway broker for publish tests: Mosquitto in a container of its own, published on a free
 * loopback port, anonymous, as the events broker is. It is started and removed by the test that
 * asks for it. It never touches a broker that already runs on the machine: its container has a
 * random name, and only that container is ever stopped, started or removed.
 *
 * When no broker can start (no container runtime, no image, no network), `startBroker` skips the
 * test with a NOT VERIFIED message. A skipped test is not a pass.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { TestContext } from "node:test";

import { connect, type MqttClient } from "mqtt";

import { pollUntil } from "../../src/util/sequence.js";
import type { Envelope, Sent } from "./support.js";

/** The image the events broker itself runs (events-cli's compose template pins the same tag). */
export const BROKER_IMAGE = process.env["CULTURE_AGENTS_TEST_BROKER_IMAGE"] || "eclipse-mosquitto:2.1.2-alpine";
const DOCKER = process.env["CULTURE_AGENTS_DOCKER_BIN"] || "docker";

export interface Subscriber {
  received: Sent[];
  envelopes(): Envelope[];
  /** Wait until `count` messages arrived. */
  waitFor(count: number, ms?: number): Promise<void>;
  close(): Promise<void>;
}

export interface TestBroker {
  /** `mqtt://127.0.0.1:<port>` */
  url: string;
  port: number;
  /** Stop the container (the port then refuses connections). */
  stop(): void;
  /** Start it again on the same port and wait until it accepts connections. */
  start(): Promise<void>;
  /** Subscribe to every run event type; resolves once the subscription is acknowledged. */
  subscribe(): Promise<Subscriber>;
}

function docker(args: string[], timeoutMs = 30_000): { ok: boolean; out: string } {
  const result = spawnSync(DOCKER, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`.trim() };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Whether the broker answers an MQTT connect on `port`. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect({ protocol: "mqtt", host: "127.0.0.1", port, reconnectPeriod: 0, connectTimeout: 1000 });
    const done = (ok: boolean): void => {
      client.removeAllListeners();
      client.on("error", () => undefined);
      client.end(true);
      resolve(ok);
    };
    client.once("connect", () => done(true));
    client.once("error", () => done(false));
    client.once("close", () => done(false));
  });
}

async function waitUntilUp(port: number, ms = 20_000): Promise<boolean> {
  return (await pollUntil(() => answers(port), { everyMs: 100, timeoutMs: ms })) === true;
}

/**
 * Start a broker for this test, or skip the test as NOT VERIFIED and return null. The container
 * is removed after the test.
 */
export async function startBroker(t: TestContext): Promise<TestBroker | null> {
  const notVerified = (why: string): null => {
    t.skip(`NOT VERIFIED: no local broker could start (${why})`);
    return null;
  };
  if (!docker(["version", "--format", "{{.Server.Version}}"], 10_000).ok) return notVerified("the container runtime does not answer");
  const port = await freePort();
  const name = `ca-test-broker-${randomBytes(6).toString("hex")}`;
  // `mosquitto-no-auth.conf` ships in the image: one listener on 1883 with anonymous access.
  const run = docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${port}:1883`, BROKER_IMAGE, "mosquitto", "-c", "/mosquitto-no-auth.conf"], 180_000);
  const remove = (): void => {
    docker(["rm", "-f", name]);
  };
  if (!run.ok) {
    remove();
    return notVerified(`${BROKER_IMAGE} did not start: ${run.out.split("\n").at(-1) ?? ""}`);
  }
  const clients: MqttClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.endAsync(true).catch(() => undefined)));
    remove();
  });
  if (!(await waitUntilUp(port))) return notVerified("the broker container never accepted a connection");

  return {
    url: `mqtt://127.0.0.1:${port}`,
    port,
    stop(): void {
      const result = docker(["stop", "-t", "1", name]);
      if (!result.ok) throw new Error(`could not stop the test broker: ${result.out}`);
    },
    async start(): Promise<void> {
      const result = docker(["start", name]);
      if (!result.ok) throw new Error(`could not start the test broker: ${result.out}`);
      if (!(await waitUntilUp(port))) throw new Error("the test broker did not come back");
    },
    subscribe(): Promise<Subscriber> {
      return subscribeTo(port, clients);
    },
  };
}

/** The subscriber over `client`, once it is subscribed; `received` fills as messages arrive. */
function subscriberOf(client: MqttClient, received: Sent[]): Subscriber {
  return {
    received,
    envelopes: () => received.map((m) => JSON.parse(m.payload) as Envelope),
    async waitFor(count: number, ms = 15_000): Promise<void> {
      if (!(await pollUntil(() => received.length >= count, { everyMs: 20, timeoutMs: ms }))) {
        throw new Error(`the subscriber got ${received.length} of ${count} messages`);
      }
    },
    close: () => client.endAsync(true),
  };
}

/** Connect a subscriber to the broker on `port`; its client joins `clients`, which the test ends after it. */
function subscribeTo(port: number, clients: MqttClient[]): Promise<Subscriber> {
  return new Promise((resolve, reject) => {
    const client = connect({ protocol: "mqtt", host: "127.0.0.1", port, reconnectPeriod: 0, connectTimeout: 5000 });
    clients.push(client);
    const received: Sent[] = [];
    client.on("message", (topic, payload) => {
      received.push({ topic, payload: payload.toString("utf8") });
    });
    client.once("error", reject);
    client.once("connect", () => {
      // One level under events/agents/run, as a dotted pattern `agents.run.*` compiles to.
      client.subscribe("events/agents/run/+", { qos: 1 }, (err) => {
        if (err) return reject(err);
        client.on("error", () => undefined);
        resolve(subscriberOf(client, received));
      });
    });
  });
}
