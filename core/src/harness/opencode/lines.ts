/**
 * Line reading for a sandbox process's output. The sandbox controls these bytes, so nothing here
 * grows without bound: a line longer than the cap is dropped (and reported once), and the lines
 * kept for diagnostics are clipped.
 */
import { MAX_STREAM_UNIT } from "./client.js";

/** Lines kept for diagnostics. */
export const TAIL_LINES = 40;
/** Characters kept of each line in the tail. */
export const TAIL_LINE_CHARS = 500;

export interface LineOptions {
  /** Longest line read; a longer one is dropped whole. Default 1 MiB of characters. */
  maxLineChars?: number;
  /** Called once per stream, the first time a line is dropped for its length. */
  onOverlong?: () => void;
}

/** Read `stream` until `pattern` matches a line; keep draining afterwards into `tail`. */
export async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, tail: string[], options: LineOptions = {}): Promise<boolean> {
  const max = options.maxLineChars ?? MAX_STREAM_UNIT;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let found = false;
  /** Inside a line that went over the cap: discard up to its newline. */
  let skipping = false;
  let reported = false;
  let notify!: (v: boolean) => void;
  const result = new Promise<boolean>((resolve) => (notify = resolve));
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        if (skipping) {
          if (lines.length === 0) {
            buf = "";
            continue;
          }
          lines.shift(); // the end of the dropped line
          skipping = false;
        }
        for (const line of lines) {
          if (line.length > max) {
            report();
            continue;
          }
          tail.push(line.slice(0, TAIL_LINE_CHARS));
          if (tail.length > TAIL_LINES) tail.shift();
          if (!found && pattern.test(line)) {
            found = true;
            notify(true);
          }
        }
        if (buf.length > max) {
          buf = "";
          skipping = true;
          report();
        }
      }
    } catch {
      // the process ended or was cancelled
    }
    notify(found);
  })();
  function report(): void {
    if (reported) return;
    reported = true;
    options.onOverlong?.();
  }
  return result;
}

/** Drain `stream` into `tail` (nothing is waited for). */
export function drain(stream: ReadableStream<Uint8Array>, tail: string[], options: LineOptions = {}): void {
  void waitForLine(stream, /$^/, tail, options);
}
