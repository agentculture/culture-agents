/**
 * A driver wrapper that enforces a capability document: a control action the document does not
 * support is refused with `UnsupportedCapabilityError` (an `unsupported` error naming the
 * capability) and is not forwarded to the wrapped driver. The deferred control actions (pause,
 * resume, answer) have no driver method at all, so they are always refused here.
 */
import type { Capabilities } from "../../contract/index.js";
import type { Driver, DriverEvent } from "../../worker/driver.js";
import { assertSupported, type ControlCapability } from "./capabilities.js";

export interface GuardedDriver extends Driver {
  /** The document the guard enforces. */
  readonly capabilities: Capabilities;
  /** The wrapped driver (tests read its reports). */
  readonly inner: Driver;
  /** Any control action by name; refused unless supported (steer and cancel forward). */
  control(action: ControlCapability, payload?: string): Promise<void>;
}

export function guardDriver(inner: Driver, doc: Capabilities): GuardedDriver {
  const guarded: GuardedDriver = {
    capabilities: doc,
    inner,
    start(): AsyncIterable<DriverEvent> {
      assertSupported(doc, "submit");
      return inner.start();
    },
    async steer(message: string) {
      assertSupported(doc, "steer");
      await inner.steer(message);
    },
    async cancel(reason: string) {
      assertSupported(doc, "cancel");
      await inner.cancel(reason);
    },
    dispose: () => inner.dispose(),
    async control(action, payload = "") {
      assertSupported(doc, action);
      if (action === "steer") return guarded.steer(payload);
      if (action === "cancel") return guarded.cancel(payload);
      // A deferred action the document claims to support cannot happen (the schema forbids it).
      throw new Error(`no driver path for ${action}`);
    },
  };
  return guarded;
}
