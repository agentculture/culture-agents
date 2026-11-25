/** Text helpers shared by the harness event mappers. */
import { appendFileSync } from "node:fs";

const MAX_TOOL_TEXT = 8000;

/** A value as bounded text: strings as-is, errors by message, anything else as JSON. */
export function stringify(value: unknown, max = MAX_TOOL_TEXT): string {
  let out: string;
  if (typeof value === "string") out = value;
  else if (value instanceof Error) out = value.message;
  else {
    try {
      out = JSON.stringify(value) ?? String(value);
    } catch {
      out = String(value);
    }
  }
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

/** `String(value)` for a value whose shape is not known (the harness sent it, so it is read as it comes). */
export const plainString = (value: unknown): string => String(value);

/** JSON replacer for the tap: strings over 4000 characters are clipped. */
const clipLongStrings = (_key: string, value: unknown): unknown =>
  typeof value === "string" && value.length > 4000 ? `${value.slice(0, 4000)}...` : value;

/**
 * A recorder for raw harness events (`tap` driver option), used by the live tests to capture
 * samples for the mapping tests. Off unless a path is given; write failures are ignored.
 */
export function tapWriter(path: string | undefined): ((raw: unknown) => void) | undefined {
  if (!path) return undefined;
  const t0 = Date.now();
  return (raw) => {
    try {
      const line = JSON.stringify({ t: Date.now() - t0, raw }, clipLongStrings);
      appendFileSync(path, `${line}\n`);
    } catch {
      // recording is best-effort
    }
  };
}
