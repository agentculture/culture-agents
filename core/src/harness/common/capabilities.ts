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
 * What `worktree_isolation` guarantees for a sandboxed harness: a sandbox clone per run, never a
 * git worktree on the host. Concurrent runs in one repository rely on exactly this (contract README).
 */
export const SANDBOX_ISOLATION =
  "Each run works in its own clone of the repository inside its own sandbox, made from a git bundle of the commit recorded at submit, and its commits return only to its own runs/<run_id> branch. This is a sandbox clone per run, not a host worktree: no git worktree is created on the host, and the host checkout and index are never written.";

/**
 * The block every harness reports the same way: the deferred capabilities unsupported; `reconnect`,
 * which the core provides itself (runs/reattach.ts), and `worktree_isolation` (a sandbox clone per
 * run; a harness without a sandbox overrides its caveat) supported. `answer` is what the driver does,
 * not what the harness could do: it is unsupported unless the harness's driver builds the ask path
 * and says so (`CapabilityInput.answer`). Today only the stub's driver does.
 */
export function deferredCapabilities(): Pick<
  CapabilitySet,
  "pause" | "resume" | "answer" | "continue_session" | "delegate" | "placement" | "worktree_isolation"
> & { reconnect: Capability } {
  // placement is supportable in the 3.0 schema (t30) but not built: every harness reports it
  // unsupported, with its reason, until D2 part two (planned).
  return {
    pause: deferred("Pausing a run is deferred beyond D1 for every harness."),
    resume: deferred("Resuming a paused run is deferred beyond D1 for every harness."),
    answer: unsupported(NO_ASK_PATH),
    continue_session: deferred("Continuing an earlier session is deferred beyond D1; every run starts a new session."),
    delegate: deferred("Agent-to-agent delegation is deferred beyond D1."),
    placement: unsupported("This core runs work only on its own node; placement on another node is not built yet (planned, D2 part two)."),
    reconnect: supported("Live control is rebuilt over the worker's own control socket; a worker that does not answer is reported unknown."),
    worktree_isolation: supported(SANDBOX_ISOLATION),
  };
}

/**
 * Why a harness whose driver has no ask path reports `answer` unsupported. The probe of plan task t1
 * (docs/d2/probe-approvals.md) measured that Claude Code and OpenCode v2 can ask and take an answer
 * (holds of up to 5 minutes; 12 hours was not measured), but their drivers here still run with
 * allow-all permissions and do not raise questions, so nothing is answered.
 */
export const NO_ASK_PATH =
  "This harness's driver has no ask path yet: it runs with allow-all permissions and never raises a question, so it takes no answer. The probe in docs/d2/probe-approvals.md shows the harness itself can ask (holds of up to 5 minutes measured, 12 hours not).";

export const supported = (...caveats: string[]): Capability => ({ supported: true, reason: null, caveats });
export const unsupported = (reason: string): Capability => ({ supported: false, reason, caveats: [] });

export interface CapabilityInput {
  harness: string;
  available: boolean;
  version: string | null;
  transport: string;
  core: Pick<CapabilitySet, "submit" | "stream" | "steer" | "cancel">;
  /** Replaces the default `answer` (unsupported, no ask path) for a harness whose driver asks. */
  answer?: Capability;
  /** Replaces the default `worktree_isolation` (a sandbox clone per run) for a harness that runs elsewhere. */
  isolation?: Capability;
  extension?: Record<string, unknown>;
}

export function capabilityDocument(input: CapabilityInput): Capabilities {
  const doc: Capabilities = {
    harness: input.harness,
    available: input.available,
    version: input.version === null ? null : input.version.slice(0, 128),
    transport: input.transport,
    capabilities: {
      ...input.core,
      ...deferredCapabilities(),
      ...(input.answer && { answer: input.answer }),
      ...(input.isolation && { worktree_isolation: input.isolation }),
    },
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
