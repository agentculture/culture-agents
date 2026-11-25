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

/** Decoded text cut into complete lines, with the cap on a line's length. */
class LineBuffer {
  private buf = "";
  /** Inside a line that went over the cap: discard up to its newline. */
  private skipping = false;

  constructor(private readonly max: number) {}

  /** Add decoded text: the lines it completes, or null while still inside a line that is being discarded. */
  add(text: string): string[] | null {
    this.buf += text;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    if (this.skipping) {
      if (lines.length === 0) {
        this.buf = "";
        return null;
      }
      lines.shift(); // the end of the dropped line
      this.skipping = false;
    }
    return lines;
  }

  /** Whether the unfinished line is over the cap; if so, it is discarded from here on. */
  overflowed(): boolean {
    if (this.buf.length <= this.max) return false;
    this.buf = "";
    this.skipping = true;
    return true;
  }
}

/** Read `stream` until `pattern` matches a line; keep draining afterwards into `tail`. */
export async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, tail: string[], options: LineOptions = {}): Promise<boolean> {
  const max = options.maxLineChars ?? MAX_STREAM_UNIT;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const buffer = new LineBuffer(max);
  let found = false;
  let reported = false;
  let notify!: (v: boolean) => void;
  const result = new Promise<boolean>((resolve) => (notify = resolve));
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = buffer.add(decoder.decode(value, { stream: true }));
        if (lines === null) continue;
        for (const line of lines) onLine(line);
        if (buffer.overflowed()) report();
      }
    } catch {
      // the process ended or was cancelled
    }
    notify(found);
  })();
  function onLine(line: string): void {
    if (line.length > max) {
      report();
      return;
    }
    tail.push(line.slice(0, TAIL_LINE_CHARS));
    if (tail.length > TAIL_LINES) tail.shift();
    if (!found && pattern.test(line)) {
      found = true;
      notify(true);
    }
  }
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
