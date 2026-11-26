/**
 * The MQTT connection to the broker. This is the only module that loads the MQTT client, and only
 * the core's publisher loads this module: no worker opens a broker connection.
 *
 * Messages go out at QoS 1 and not retained, as the broker's own envelope publisher sends them
 * (events-cli `EventClient.publish_event`): a QoS 0 envelope is never queued for a subscriber that
 * is offline. The client reconnects on its own. A publish without a connection is refused at
 * once and nothing is queued in memory: the run log is the queue, and the follower offers the
 * event again.
 */
import { randomBytes } from "node:crypto";

import { connect, type MqttClient } from "mqtt";

import type { PublishConfig } from "./config.js";
import type { BrokerTransport } from "./publisher.js";

export interface TransportOptions {
  /** How long one publish may wait for the broker's acknowledgement. Default 10 s. */
  ackTimeoutMs?: number;
  /** Pause between connection attempts. Default 1 s. */
  reconnectMs?: number;
}

/** The broker did not take the message. */
export class BrokerUnavailableError extends Error {
  override readonly name = "BrokerUnavailableError";
}

/** Start connecting (in the background) and return the transport. Never throws for a broker that is down. */
export function connectBroker(config: PublishConfig, options: TransportOptions = {}): BrokerTransport {
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const client: MqttClient = connect({
    protocol: "mqtt",
    host: config.host,
    port: config.port,
    clientId: `culture-agents-core-${randomBytes(6).toString("hex")}`,
    clean: true,
    reconnectPeriod: options.reconnectMs ?? 1000,
    connectTimeout: 5000,
    queueQoSZero: false,
    resubscribe: false,
  });
  let lastError = "not connected";
  // Without a listener an `error` event would be an uncaught exception in the core.
  client.on("error", (err) => {
    lastError = err.message.split("\n")[0] ?? "error";
  });

  return {
    publish(topic: string, payload: string): Promise<void> {
      if (!client.connected) return Promise.reject(new BrokerUnavailableError(lastError));
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          // Take it out of the client's resend store: the follower offers the event again itself.
          if (messageId !== undefined) client.removeOutgoingMessage(messageId);
          reject(new BrokerUnavailableError(`no acknowledgement within ${ackTimeoutMs} ms`));
        }, ackTimeoutMs);
        client.publish(topic, payload, { qos: 1, retain: false }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(new BrokerUnavailableError(err.message.split("\n")[0] ?? "publish failed"));
          else resolve();
        });
        const messageId: number | undefined = client.getLastMessageId();
      });
    },
    async close(): Promise<void> {
      await client.endAsync(true);
    },
  };
}
