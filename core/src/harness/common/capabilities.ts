/**
 * Capability documents and honest refusal. Every harness reports the deferred capabilities as
 * unsupported (contract README, "Deferred capabilities"), even where the harness itself could do
 * them. A control action outside the document is refused with a typed `unsupported` error naming
 * the capability, and never forwarded to the harness.
 */
import type {
  Capabilities,
  Capability,
  CapabilityName,
  CapabilitySet,
  Deferred,
  ErrorBody,
} from "../../contract/index.js";

const deferred = (reason: string): Deferred => ({ supported: false, reason, caveats: [] });

/**
 * The block every harness reports as unsupported today. `answer`, `reconnect` and
 * `worktree_isolation` may be supported since API 3.0, but no driver or core path builds them yet,
 * so they are reported unsupported, with the reason.
 */
export function deferredCapabilities(): Pick<
  CapabilitySet,
  "pause" | "resume" | "answer" | "continue_session" | "delegate" | "placement" | "reconnect" | "worktree_isolation"
> {
  return {
    pause: deferred("Pausing a run is deferred beyond D1 for every harness."),
    resume: deferred("Resuming a paused run is deferred beyond D1 for every harness."),
    answer: unsupported("Operator questions are deferred beyond D1; runs use allow-all permissions and never ask."),
    continue_session: deferred("Continuing an earlier session is deferred beyond D1; every run starts a new session."),
    delegate: deferred("Agent-to-agent delegation is deferred beyond D1."),
    placement: deferred("D1 runs on a single host; placement on another node is deferred."),
    reconnect: unsupported("D1 cannot reattach live control to a worker that survived a core restart."),
    worktree_isolation: unsupported("One active run per repository in D1; concurrent runs in one repository are deferred."),
  };
}

export const supported = (...caveats: string[]): Capability => ({ supported: true, reason: null, caveats });
export const unsupported = (reason: string): Capability => ({ supported: false, reason, caveats: [] });

export interface CapabilityInput {
  harness: string;
  available: boolean;
  version: string | null;
  transport: string;
  core: Pick<CapabilitySet, "submit" | "stream" | "steer" | "cancel">;
  extension?: Record<string, unknown>;
}

export function capabilityDocument(input: CapabilityInput): Capabilities {
  const doc: Capabilities = {
    harness: input.harness,
    available: input.available,
    version: input.version === null ? null : input.version.slice(0, 128),
    transport: input.transport,
    capabilities: { ...input.core, ...deferredCapabilities() },
  };
  if (input.extension) doc.extension = input.extension;
  return doc;
}

/** The control actions that reach a driver, and the deferred ones that never do. */
export type ControlCapability = Extract<CapabilityName, "steer" | "cancel" | "pause" | "resume" | "answer">;

/** The `unsupported` error for `capability`, or null when the document supports it. */
export function refusalFor(doc: Capabilities, capability: CapabilityName): ErrorBody | null {
  const cap = doc.capabilities[capability];
  if (cap.supported) return null;
  return {
    code: "unsupported",
    message: `The ${doc.harness} harness does not support ${capability}: ${cap.reason ?? "not supported"}`.slice(0, 2000),
    retryable: false,
    capability,
  };
}

/** Thrown by a guarded driver for an action outside its capability document. */
export class UnsupportedCapabilityError extends Error {
  override readonly name = "UnsupportedCapabilityError";
  readonly code = "unsupported" as const;
  constructor(readonly body: ErrorBody) {
    super(body.message);
  }
  get capability(): CapabilityName {
    return this.body.capability as CapabilityName;
  }
}

/** Throw `UnsupportedCapabilityError` unless the document supports `capability`. */
export function assertSupported(doc: Capabilities, capability: CapabilityName): void {
  const refusal = refusalFor(doc, capability);
  if (refusal) throw new UnsupportedCapabilityError(refusal);
}
