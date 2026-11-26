/**
 * Publishing run events to the workspace's events broker, as a second transport next to the run
 * logs. Off unless a broker address is configured. See `publisher.ts` for the guarantees and
 * `envelope.ts` for what a message holds.
 */
import { loadPublishConfig, BROKER_URL_ENV } from "./config.js";
import { sourceFor } from "./envelope.js";
import { createPublisher, type Publisher } from "./publisher.js";

export { BROKER_URL_ENV, DEFAULT_BROKER_PORT, PublishConfigError, loadPublishConfig } from "./config.js";
export type { PublishConfig } from "./config.js";
export { EnvelopeError, MAX_TYPE_SEGMENTS, SCHEMA_VERSION, TOPIC_PREFIX, TYPE_PREFIX, buildMessage, eventId, eventType, sourceFor, topicFor } from "./envelope.js";
export type { BrokerEnvelope, BrokerMessage, RunFact } from "./envelope.js";
export { LogHeldError, POSITION_FILE, pendingFacts, readPosition, writePosition } from "./log-tail.js";
export type { PendingFact, PublishPosition } from "./log-tail.js";
export { createPublisher } from "./publisher.js";
export type { BrokerTransport, Publisher, PublisherOptions } from "./publisher.js";

export interface StartPublishingOptions {
  stateDir: string;
  node: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Where one-line diagnostics go (the core's stderr). */
  log: (line: string) => void;
}

/**
 * Start publishing when a broker is configured; resolves to null when it is not, or when the
 * configuration cannot be used (said in one line). It never throws and never waits for the
 * broker: the core starts and serves the same way with the broker up, down or absent.
 */
export async function startPublishing(options: StartPublishingOptions): Promise<Publisher | null> {
  try {
    const config = loadPublishConfig(options.env ?? process.env);
    if (config === null) return null;
    // Loaded only when publishing is on: a core without a broker never loads the MQTT client.
    const { connectBroker } = await import("./transport.js");
    const publisher = createPublisher({ stateDir: options.stateDir, source: sourceFor(options.node), transport: connectBroker(config), warn: options.log });
    publisher.start();
    options.log(`culture-agents core: publishing run events to the broker at ${config.url} (${BROKER_URL_ENV}).`);
    return publisher;
  } catch (err) {
    options.log(`culture-agents core: run events are not published: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
