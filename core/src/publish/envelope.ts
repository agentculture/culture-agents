/**
 * The message the core publishes for one run event: the broker's existing envelope, carrying
 * lifecycle facts only.
 *
 * The broker is the workspace's events broker (events-cli: Mosquitto on loopback, anonymous). Its
 * consumers read a CloudEvents-shaped JSON envelope and drop, for good, any payload that does not
 * parse as one. events-cli has no schema file, only its reader, so the rules are restated here and
 * checked before anything is published (events_cli/core/envelope.py, events_cli/core/topics.py and
 * docs/contract.md in that repository):
 *
 * - required fields `id`, `type`, `source`, `time`, `schemaVersion`, `data`; an unknown top-level
 *   field is refused, so everything of ours goes inside `data`; absent fields are omitted;
 * - `type` is lowercase dotted segments; `id` and `runId` are at most 128 printable characters
 *   without whitespace; `source` is an absolute URI; `time` is RFC 3339 in UTC;
 * - the topic is `events/` plus the type with each dot as a topic level;
 * - delivery is at-least-once, so consumers dedupe on `id`.
 *
 * What a message holds: the run id, the event kind, the run's state after the event, the cursor
 * and the time. Never the prompt, harness output, a tool result, a question or an answer: the
 * broker accepts anonymous local subscribers, which is wider than the owner-only run logs. A
 * subscriber that wants content reads it from the core by cursor.
 */
import { createHash } from "node:crypto";

/** Every type the core publishes starts with this. No other product publishes under it. */
export const TYPE_PREFIX = "agents.run";
/** Consumers subscribe to types of up to this many segments; a longer type would be dropped silently. */
export const MAX_TYPE_SEGMENTS = 4;
/** The broker's envelope schema version. */
export const SCHEMA_VERSION = "1";
/** First topic level of every envelope topic. */
export const TOPIC_PREFIX = "events";

const MAX_ID_LENGTH = 128;
const MAX_TYPE_LENGTH = 128;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:+/=@-]*$/;
const TYPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
/** One type segment of ours: a word, which may hold `_` (as `timed_out` does) but no separator. */
const WORD = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** RFC 3339 in UTC with a `Z`: the form the event log writes. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const NODE = /^[a-z0-9]{1,32}$/;

/** A fact cannot be published in the broker's envelope. The caller holds the run there; it never guesses. */
export class EnvelopeError extends Error {
  override readonly name = "EnvelopeError";
}

/** What is published about one run event. */
export interface RunFact {
  run_id: string;
  /** The event's kind in the run log, for example `run.state`. */
  kind: string;
  /** The run's state after this event. */
  state: string;
  cursor: number;
  /** The event's time in the run log. */
  time: string;
}

export interface BrokerEnvelope {
  id: string;
  type: string;
  source: string;
  time: string;
  schemaVersion: string;
  runId: string;
  data: { run_id: string; kind: string; state: string; cursor: number };
}

export interface BrokerMessage {
  topic: string;
  /** The envelope as compact JSON: what is sent. */
  payload: string;
  envelope: BrokerEnvelope;
}

/**
 * The type of one run event: `agents.run.<state>` for a state transition (`agents.run.succeeded`),
 * and `agents.run.<kind without "run.">` for every other kind (`agents.run.output`). Always three
 * segments. A kind or state that is not one lowercase word is refused.
 */
export function eventType(kind: string, state: string): string {
  if (!kind.startsWith("run.") || !WORD.test(kind.slice(4))) throw new EnvelopeError(`event kind ${JSON.stringify(kind)} cannot be published as a type`);
  if (kind !== "run.state") return `${TYPE_PREFIX}.${kind.slice(4)}`;
  if (!WORD.test(state)) throw new EnvelopeError(`state ${JSON.stringify(state)} cannot be published as a type`);
  return `${TYPE_PREFIX}.${state}`;
}

/**
 * The id of one run event: `<run id>:<cursor>`. It depends on nothing else, so publishing the same
 * event again gives the same id. When that would pass the broker's 128-character limit (a run id
 * may be 127), the run id is replaced by `sha256.` and the hex SHA-256 of the run id.
 */
export function eventId(runId: string, cursor: number): string {
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw new EnvelopeError(`cursor ${String(cursor)} is not a positive integer`);
  const plain = `${runId}:${cursor}`;
  if (plain.length <= MAX_ID_LENGTH) return plain;
  return `sha256.${createHash("sha256").update(runId, "utf8").digest("hex")}:${cursor}`;
}

/** The topic of a type: `agents.run.succeeded` -> `events/agents/run/succeeded`. */
export function topicFor(type: string): string {
  if (type.length > MAX_TYPE_LENGTH || !TYPE.test(type)) throw new EnvelopeError(`type ${JSON.stringify(type)} is not lowercase dotted segments`);
  const segments = type.split(".");
  if (segments.length > MAX_TYPE_SEGMENTS) throw new EnvelopeError(`type ${type} has more than ${MAX_TYPE_SEGMENTS} segments`);
  return [TOPIC_PREFIX, ...segments].join("/");
}

/** The envelope `source` of this core: an absolute URI naming the product and the node. */
export function sourceFor(node: string): string {
  if (!NODE.test(node)) throw new EnvelopeError("the node name is not a mesh node name");
  return `app://culture-agents/${node}`;
}

/** Build the message for one fact. Throws `EnvelopeError` when the broker's reader would drop it. */
export function buildMessage(fact: RunFact, source: string): BrokerMessage {
  if (fact.run_id.length > MAX_ID_LENGTH || !ID.test(fact.run_id)) throw new EnvelopeError("the run id cannot be an envelope identifier");
  if (!TIME.test(fact.time)) throw new EnvelopeError("the event time is not an RFC 3339 UTC timestamp");
  if (!URL.canParse(source) || /\s/.test(source)) throw new EnvelopeError("the source is not an absolute URI");
  const type = eventType(fact.kind, fact.state);
  if (!WORD.test(fact.state)) throw new EnvelopeError(`state ${JSON.stringify(fact.state)} cannot be published`);
  const envelope: BrokerEnvelope = {
    id: eventId(fact.run_id, fact.cursor),
    type,
    source,
    time: fact.time,
    schemaVersion: SCHEMA_VERSION,
    runId: fact.run_id,
    data: { run_id: fact.run_id, kind: fact.kind, state: fact.state, cursor: fact.cursor },
  };
  return { topic: topicFor(type), payload: JSON.stringify(envelope), envelope };
}
