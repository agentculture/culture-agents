import { createHash } from "node:crypto";

/** OpenShell rejects sandbox names longer than this (`name exceeds maximum length`). */
export const MAX_SANDBOX_NAME = 19;

/** Default sandbox-name prefix for runs started by the core. */
export const DEFAULT_PREFIX = "ca-";

/** Label keys every run sandbox carries, so a crashed process can find its sandboxes again. */
export const LABEL_MANAGED_BY = "managed-by";
export const LABEL_MANAGED_BY_VALUE = "culture-agents";
/** The full run id, when it fits one label value (at most 63 characters, alphanumeric at both ends). */
export const LABEL_RUN_ID = "run-id";
/** A hash of the run id; always present and always a valid label value, whatever the id's length. */
export const LABEL_RUN_KEY = "run-key";
/** Prefix of the labels holding a run id too long for one label value: `run-id-1`, `run-id-2`, ... */
export const LABEL_RUN_ID_PART = "run-id-";

/** Longest run id: the contract's `<node>-<agent>.run.<ULID>` with a 96-character mesh id. */
export const MAX_RUN_ID = 127;
/** OpenShell (Kubernetes-style) label values: 63 characters, alphanumeric at both ends. */
const LABEL_VALUE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
/** Characters of the run id per part label; each part is wrapped in `x...x` to keep both ends alphanumeric. */
const PART = 61;

const RUN_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_RUN_ID - 1}}$`);
const PREFIX = /^[a-z][a-z0-9-]{0,8}$/;

/** Thrown for a run id or prefix the sandbox layer refuses; never reaches the gateway. */
export class InvalidRunIdError extends Error {
  override readonly name = "InvalidRunIdError";
}

/**
 * Validate a run id. It becomes a label value and part of the `runs/<id>` git
 * branch, so it is held to a charset that is safe in both places.
 */
export function validateRunId(runId: string): string {
  if (!RUN_ID.test(runId) || runId.includes("..") || runId.endsWith(".lock") || runId.endsWith(".")) {
    throw new InvalidRunIdError(
      `invalid run id ${JSON.stringify(runId)}: use 1-${MAX_RUN_ID} of [A-Za-z0-9._-], ` +
        "starting alphanumeric, without '..' or a trailing '.' or '.lock'",
    );
  }
  return runId;
}

export function validatePrefix(prefix: string): string {
  if (!PREFIX.test(prefix)) {
    throw new InvalidRunIdError(
      `invalid sandbox prefix ${JSON.stringify(prefix)}: 1-9 of [a-z0-9-], starting with a letter`,
    );
  }
  return prefix;
}

/**
 * Deterministic sandbox name for a run: the prefix plus a sha256 of the run id,
 * cut to OpenShell's 19-character cap. The same run id always maps to the same
 * name, so create, resume and delete need nothing but the run id.
 */
export function sandboxName(runId: string, prefix: string = DEFAULT_PREFIX): string {
  validateRunId(runId);
  validatePrefix(prefix);
  const hash = createHash("sha256").update(runId).digest("hex");
  return `${prefix}${hash}`.slice(0, MAX_SANDBOX_NAME);
}

/** The git branch a run works on, inside the sandbox and on the host after collect. */
export function runBranch(runId: string): string {
  return `runs/${validateRunId(runId)}`;
}

/** The run-key label value: 48 hex digits of sha256(run id). Selector-safe for any run id. */
export function runKey(runId: string): string {
  return createHash("sha256").update(`run-key:${runId}`).digest("hex").slice(0, 48);
}

/**
 * Labels of a run's sandbox. Label values are capped at 63 characters and must be alphanumeric at
 * both ends, but a contract run id can be 127 characters long. So every sandbox carries
 * `run-key` (a hash, always valid) and the full id: in `run-id` when it is a valid label value,
 * otherwise split over `run-id-1`, `run-id-2`, ..., each part wrapped as `x<part>x`.
 */
export function runLabels(runId: string): Record<string, string> {
  validateRunId(runId);
  const labels: Record<string, string> = { [LABEL_MANAGED_BY]: LABEL_MANAGED_BY_VALUE, [LABEL_RUN_KEY]: runKey(runId) };
  if (LABEL_VALUE.test(runId)) {
    labels[LABEL_RUN_ID] = runId;
    return labels;
  }
  for (let i = 0; i * PART < runId.length; i++) labels[`${LABEL_RUN_ID_PART}${i + 1}`] = `x${runId.slice(i * PART, (i + 1) * PART)}x`;
  return labels;
}

/** The full run id recorded in a sandbox's labels (see `runLabels`), or null when there is none. */
export function runIdFromLabels(labels: Readonly<Record<string, string>>): string | null {
  const whole = labels[LABEL_RUN_ID];
  if (whole) return whole;
  let id = "";
  for (let i = 1; ; i++) {
    const part = labels[`${LABEL_RUN_ID_PART}${i}`];
    if (part === undefined) break;
    if (part.length < 2 || !part.startsWith("x") || !part.endsWith("x")) return null;
    id += part.slice(1, -1);
  }
  return id === "" ? null : id;
}

/**
 * Whether a sandbox's labels belong to `runId`: the recorded full id matches, and so does the run
 * key when there is one (sandboxes created before the key existed carry only `run-id`).
 */
export function labelsMatchRun(labels: Readonly<Record<string, string>>, runId: string): boolean {
  const key = labels[LABEL_RUN_KEY];
  if (key !== undefined && key !== runKey(runId)) return false;
  return runIdFromLabels(labels) === runId;
}
