/**
 * The host's admission state for the capability report (contract README: limits, load and
 * admission). Every signal reads admit, hold or unknown; a missing, stale, unreadable or
 * malformed reading is unknown, never admit, and never a failure of the control plane.
 *
 * Heat is read as its publisher writes it. heat-governor's daemon writes `state.json` about once a
 * second (heat-governor docs/contracts/state.md and heat_governor/client.py, 0.20.1, as recorded
 * in the spec, s10): `host`, `at` (epoch seconds, a number), `stale_after_s`, `level`, `admit`
 * (false in hot and critical) and `concurrency_factor`. Path: `$HEAT_GOVERNOR_STATE`, else
 * `$XDG_RUNTIME_DIR/heat-governor/state.json`. NOT VERIFIED on a live host: the publisher is not
 * on the host this was written on, so the format is the spec's citation of it; readers take
 * the payload through an injectable `read`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Admission, Capabilities, Limits, Signal, SignalName, Warning } from "../contract/index.js";
import { activeRunList } from "../store/entries.js";

type Env = Readonly<Record<string, string | undefined>>;

export const GATEWAY_NOT_CONSULTED =
  "not consulted: the gateway's admit field with a timestamp (lobes-cli issue 346) is not released, so the gateway does not affect admission";

/** The heat-governor state file path, or null when neither variable names a place. */
export function heatStatePath(env: Env): string | null {
  const explicit = env["HEAT_GOVERNOR_STATE"];
  if (explicit) return explicit;
  const runtime = env["XDG_RUNTIME_DIR"];
  return runtime ? join(runtime, "heat-governor", "state.json") : null;
}

const unknownHeat = (reason: string, observedAt: string | null = null): Signal => ({ state: "unknown", consulted: true, reason, observed_at: observedAt });

/** Interpret one heat payload (the text of state.json) at `now`. */
export function heatFromPayload(text: string, now: Date): Signal {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return unknownHeat("the heat-governor state file is not valid JSON");
  }
  const o = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  const at = o?.["at"];
  const window = o?.["stale_after_s"];
  if (o === null || typeof at !== "number" || !Number.isFinite(at) || typeof window !== "number" || !Number.isFinite(window) || window <= 0 || typeof o["admit"] !== "boolean") {
    return unknownHeat("the heat-governor state file lacks a numeric at, a positive stale_after_s or a boolean admit");
  }
  const observed = new Date(at * 1000);
  if (Number.isNaN(observed.getTime())) return unknownHeat("the heat-governor state file has an unusable at");
  const observedAt = observed.toISOString();
  const ageMs = now.getTime() - observed.getTime();
  if (ageMs > window * 1000) return unknownHeat(`the heat reading is stale: ${Math.round(ageMs / 1000)}s old, stale after ${window}s`, observedAt);
  if (ageMs < -window * 1000) return unknownHeat("the heat reading is stamped in the future", observedAt);
  if (o["admit"]) return { state: "admit", consulted: true, reason: null, observed_at: observedAt };
  const level = typeof o["level"] === "string" ? o["level"] : "unreported";
  return { state: "hold", consulted: true, reason: `heat-governor says hold (level ${level})`, observed_at: observedAt };
}

/** Read the heat signal now. `read` is injectable (default: the file at `heatStatePath`). */
export function readHeat(env: Env, now: Date, read: (path: string) => string = (p) => readFileSync(p, "utf8")): Signal {
  const path = heatStatePath(env);
  if (path === null) return unknownHeat("no heat-governor state path: neither HEAT_GOVERNOR_STATE nor XDG_RUNTIME_DIR is set");
  let text: string;
  try {
    text = read(path);
  } catch {
    return unknownHeat(`the heat-governor state file ${path} is missing or unreadable`);
  }
  return heatFromPayload(text, now);
}

export function readAdmission(env: Env, now: Date, read?: (path: string) => string): Admission {
  return {
    heat: readHeat(env, now, read),
    gateway: { state: "unknown", consulted: false, reason: GATEWAY_NOT_CONSULTED, observed_at: null },
  };
}

/** What a capability document says about this core's host. */
export interface HostReport {
  limits: Limits;
  stateDir: string;
  env: Env;
  now: Date;
  readHeatFile?: (path: string) => string;
}

/** The number of active runs on the host. The tracing gauge counts through the same list. */
export function countActiveRuns(stateDir: string): number {
  return activeRunList(stateDir).length;
}

/** The document with `limits`, `active_runs` and `admission` added (this core's own host only). */
export function withHostReport(doc: Capabilities, report: HostReport): Capabilities {
  return { ...doc, limits: { ...report.limits }, active_runs: countActiveRuns(report.stateDir), admission: readAdmission(report.env, report.now, report.readHeatFile) };
}

/** Warnings for a local submit: one per consulted signal that reads unknown. */
export function submitWarnings(admission: Admission): Warning[] {
  const out: Warning[] = [];
  for (const name of ["heat", "gateway"] as SignalName[]) {
    const signal = admission[name];
    if (signal.consulted && signal.state === "unknown") {
      out.push({ code: "signal_unknown", signal: name, message: `The ${name} signal reads unknown (${signal.reason ?? "no reading"}); this local submit was admitted without it.` });
    }
  }
  return out;
}
