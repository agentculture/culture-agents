import { createHash } from "node:crypto";

/** OpenShell rejects sandbox names longer than this (`name exceeds maximum length`). */
export const MAX_SANDBOX_NAME = 19;

/** Default sandbox-name prefix for runs started by the core. */
export const DEFAULT_PREFIX = "ca-";

/** Label keys every run sandbox carries, so a crashed process can find its sandboxes again. */
export const LABEL_MANAGED_BY = "managed-by";
export const LABEL_MANAGED_BY_VALUE = "culture-agents";
export const LABEL_RUN_ID = "run-id";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
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
      `invalid run id ${JSON.stringify(runId)}: use 1-63 of [A-Za-z0-9._-], ` +
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

export function runLabels(runId: string): Record<string, string> {
  return { [LABEL_MANAGED_BY]: LABEL_MANAGED_BY_VALUE, [LABEL_RUN_ID]: validateRunId(runId) };
}
