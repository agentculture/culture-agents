// One run's OpenShell sandbox: exec, file I/O, spawn with cancel, port
// forwards, stop and destroy. Everything goes through the OpenShell SDK's
// exec / execInteractive / forward / delete; no `openshell` CLI calls.
import { posix } from "node:path";

import type { ForwardRef, OpenShellClientLike } from "./openshell-client.js";
import type {
  ExecOptions,
  ExecResult,
  PortEndpoint,
  RunProcess,
  RunSandbox,
  RunSandboxState,
  SpawnOptions,
} from "./types.js";

/** Operator credentials that must never be passed into a sandbox, whatever the caller asks. */
export const SCRUBBED_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"] as const;

/** Exit code a sentinel script returns when a path does not exist. */
export const NOT_FOUND_EXIT = 44;
/** Bytes per exec call when writing a file (kept well under gRPC message limits). */
export const WRITE_CHUNK = 1 << 20;
/** Exit code reported for a process that ended without sending one (cancelled). */
export const CANCELLED_EXIT = 137;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function scrubEnv(env?: Readonly<Record<string, string>>): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!(SCRUBBED_ENV as readonly string[]).includes(key)) out[key] = value;
  }
  return out;
}

export interface Deleter {
  /** Delete by name with retries and wait until gone; throws SandboxCleanupError. */
  (name: string, runId: string): Promise<void>;
}

interface PushStream {
  stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
}

function pushStream(): PushStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  return {
    stream,
    push: (chunk) => {
      try {
        controller.enqueue(new Uint8Array(chunk));
      } catch {
        // The consumer cancelled the stream; drop further output.
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        // Already closed or cancelled.
      }
    },
  };
}

export class OpenShellRunSandbox implements RunSandbox {
  #state: RunSandboxState = "ready";
  readonly #processes = new Set<RunProcess>();
  readonly #forwards = new Map<number, ForwardRef>();
  #destroying: Promise<void> | undefined;

  constructor(
    readonly runId: string,
    readonly name: string,
    readonly home: string,
    private readonly client: OpenShellClientLike,
    private readonly deleter: Deleter,
    private readonly onDestroyed: () => void,
    private readonly log?: (message: string) => void,
  ) {}

  get state(): RunSandboxState {
    return this.#state;
  }

  resolve(path: string): string {
    return posix.isAbsolute(path) ? path : posix.resolve(this.home, path);
  }

  #assertUsable(): void {
    if (this.#state === "destroyed") throw new Error(`sandbox ${this.name} is destroyed`);
  }

  async exec(script: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.#assertUsable();
    options.signal?.throwIfAborted();
    const env = scrubEnv(options.env);
    const res = await this.client.exec(this.name, ["sh", "-c", script], {
      workdir: options.cwd ? this.resolve(options.cwd) : this.home,
      noLoginShell: true,
      ...(env ? { environment: env } : {}),
      ...(options.stdin ? { stdin: Buffer.from(options.stdin) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  }

  async readFile(path: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | null> {
    const p = shellQuote(this.resolve(path));
    const res = await this.exec(
      `[ -e ${p} ] || exit ${NOT_FOUND_EXIT}; [ -d ${p} ] && exit 45; cat -- ${p}`,
      options.signal ? { signal: options.signal } : {},
    );
    if (res.exitCode === NOT_FOUND_EXIT) return null;
    if (res.exitCode !== 0) {
      throw new Error(`read ${path}: exit ${res.exitCode}: ${Buffer.from(res.stderr).toString()}`);
    }
    return new Uint8Array(res.stdout);
  }

  async writeFile(path: string, content: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<void> {
    const full = this.resolve(path);
    const q = shellQuote(full);
    const signal = options.signal ? { signal: options.signal } : {};
    let offset = 0;
    do {
      const chunk = content.subarray(offset, offset + WRITE_CHUNK);
      const script =
        offset === 0 ? `mkdir -p ${shellQuote(posix.dirname(full))} && cat > ${q}` : `cat >> ${q}`;
      const res = await this.exec(script, { stdin: chunk, ...signal });
      if (res.exitCode !== 0) {
        throw new Error(`write ${path}: exit ${res.exitCode}: ${Buffer.from(res.stderr).toString()}`);
      }
      offset += chunk.length;
    } while (offset < content.length);
  }

  async spawn(command: string, options: SpawnOptions = {}): Promise<RunProcess> {
    this.#assertUsable();
    options.signal?.throwIfAborted();
    const env = scrubEnv(options.env);
    const ctl = await this.client.execInteractive(this.name, ["sh", "-c", command], {
      workdir: options.cwd ? this.resolve(options.cwd) : this.home,
      tty: false,
      noLoginShell: true,
      ...(env ? { environment: env } : {}),
    });
    if (!options.stdin) ctl.closeInput();
    const out = pushStream();
    const err = pushStream();
    let cancelled = false;
    const exited = (async () => {
      let code: number | undefined;
      try {
        for await (const ev of ctl.output) {
          if ("type" in ev) code = ev.exitCode;
          else if (ev.stream === "stdout") out.push(ev.data);
          else err.push(ev.data);
        }
      } catch (error) {
        this.log?.(`spawn stream ended: ${(error as Error).message}`);
      }
      out.close();
      err.close();
      return { exitCode: code ?? CANCELLED_EXIT };
    })();
    const proc: RunProcess = {
      stdout: out.stream,
      stderr: err.stream,
      write: (data) => {
        if (!options.stdin) throw new Error("process was spawned without stdin");
        ctl.write(Buffer.from(data));
      },
      closeInput: () => ctl.closeInput(),
      wait: () => exited,
      cancel: async () => {
        if (cancelled) return;
        cancelled = true;
        ctl.cancel();
      },
    };
    this.#processes.add(proc);
    void exited.then(() => this.#processes.delete(proc));
    options.signal?.addEventListener("abort", () => void proc.cancel(), { once: true });
    return proc;
  }

  async endpoint(port: number): Promise<PortEndpoint> {
    this.#assertUsable();
    let fwd = this.#forwards.get(port);
    if (!fwd) {
      fwd = await this.client.forward(this.name, {
        targetPort: port,
        onConnectionError: (e) => this.log?.(`forward ${port}: ${e.message}`),
      });
      this.#forwards.set(port, fwd);
    }
    return { host: fwd.localHost || "127.0.0.1", port: fwd.localPort };
  }

  async stop(): Promise<void> {
    for (const proc of [...this.#processes]) {
      await proc.cancel().catch(() => undefined);
    }
    this.#processes.clear();
    for (const fwd of this.#forwards.values()) {
      await fwd.close().catch(() => undefined);
    }
    this.#forwards.clear();
    if (this.#state === "ready") this.#state = "stopped";
  }

  destroy(): Promise<void> {
    // One deletion in flight at a time; a failed one can be retried.
    this.#destroying ??= (async () => {
      await this.stop();
      await this.deleter(this.name, this.runId);
      this.#state = "destroyed";
      this.onDestroyed();
    })().finally(() => {
      if (this.#state !== "destroyed") this.#destroying = undefined;
    });
    return this.#destroying;
  }
}
