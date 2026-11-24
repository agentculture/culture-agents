import type { ErrorBody } from "./generated/index.js";

/** One schema violation, flattened from the validator's output. */
export interface ValidationIssue {
  /** JSON Pointer to the offending value ("" is the document root). A missing required property is reported at that property. */
  path: string;
  /** The JSON Schema keyword that failed (`required`, `pattern`, `additionalProperties`, ...). */
  keyword: string;
  message: string;
}

/**
 * Thrown by `assertValid`. Carries the contract error code `invalid` and the failing
 * path, so a daemon can answer with `toBody()` as-is.
 */
export class ContractValidationError extends Error {
  readonly code = "invalid" as const;
  readonly path: string;
  readonly issues: readonly ValidationIssue[];

  constructor(schemaName: string, issues: readonly ValidationIssue[]) {
    const first = issues[0];
    const path = first?.path ?? "";
    super(`${schemaName} is invalid at ${path === "" ? "(root)" : path}: ${first?.message ?? "unknown"}`);
    this.name = "ContractValidationError";
    this.path = path;
    this.issues = issues;
  }

  /** The `error.json` body for this failure (`field` is omitted for a root-level failure). */
  toBody(): ErrorBody {
    const body: ErrorBody = { code: "invalid", message: this.message.slice(0, 2000), retryable: false };
    if (this.path !== "") body.field = this.path.slice(0, 200);
    return body;
  }
}
