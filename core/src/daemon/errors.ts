import { retryableFor, type ErrorBody, type ErrorCode } from "../contract/index.js";

/** Extra fields an error body may carry (contract/error.json). */
export type ErrorExtras = Partial<Omit<ErrorBody, "code" | "message" | "retryable">> & { retryable?: boolean };

/** A typed contract error. Thrown by the server and by `RunService` implementations; rendered as an `error.json` body. */
export class ControlError extends Error {
  readonly body: ErrorBody;

  constructor(code: ErrorCode, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = "ControlError";
    const { retryable, ...rest } = extras;
    // `conflict` is the only code whose retryable flag varies; callers must say which.
    const fixed = retryableFor(code);
    this.body = { code, message, retryable: fixed ?? retryable ?? false, ...rest };
  }
}

export function invalid(message: string, field?: string): ControlError {
  return new ControlError("invalid", message, field === undefined ? {} : { field });
}

export function notFound(message: string, extras: ErrorExtras = {}): ControlError {
  return new ControlError("not_found", message, extras);
}

export function unsupported(capability: NonNullable<ErrorBody["capability"]>, message: string): ControlError {
  return new ControlError("unsupported", message, { capability });
}

export function unavailable(message: string): ControlError {
  return new ControlError("unavailable", message);
}
