// In-memory stand-in for the OpenShell gateway. Records every call; no network.
import type {
  CreateSpec,
  ExecReply,
  ExecRequest,
  InteractiveControl,
  OpenShellClientLike,
  SandboxInfo,
  StreamEvent,
} from "../../src/sandbox/openshell-client.js";

export interface Call {
  op: string;
  name: string;
  detail?: unknown;
}

interface FakeSandbox {
  phase: string;
  labels: Record<string, string>;
  files: Map<string, Buffer>;
  spec: CreateSpec;
}

export class SdkLikeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The label-value rules the real gateway enforces (observed live: `invalid_config` "label value
 * exceeds 63 characters", "must start/end with alphanumeric character").
 */
export function checkLabels(labels: Record<string, string>): void {
  for (const value of Object.values(labels)) {
    if (value.length > 63) throw new SdkLikeError("invalid_config", `label value exceeds 63 characters: '${value}'`);
    if (value !== "" && !/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
      throw new SdkLikeError("invalid_config", `label value must start and end with alphanumeric character: '${value}'`);
    }
  }
}

/** Interactive session whose output the test drives. */
export class FakeInteractive implements InteractiveControl {
  readonly written: Buffer[] = [];
  inputClosed = false;
  cancelled = false;
  readonly #queue: StreamEvent[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  emit(ev: StreamEvent): void {
    this.#queue.push(ev);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  get output(): AsyncIterable<StreamEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#next(),
        // A consumer that stops early (a `break`, or `return()` by hand) gets a finished iterator.
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    };
  }

  /** The next queued event, the end of the stream, or a wait for whichever `emit` or `end` brings. */
  #next(): Promise<IteratorResult<StreamEvent>> {
    const next = this.#queue.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise<void>((resolve) => (this.#wake = resolve)).then(() => this.#next());
  }

  write(data: Buffer): void {
    this.written.push(Buffer.from(data));
  }
  closeInput(): void {
    this.inputClosed = true;
  }
  cancel(): void {
    this.cancelled = true;
    this.end();
  }
}

export interface FakeOptions {
  createError?: Error;
  /** Create the sandbox, then throw (a timeout after the gateway acted). */
  createThenThrow?: Error;
  waitReadyError?: Error;
  /** Number of delete calls that fail before one succeeds. */
  deleteFailures?: number;
  onExec?: (name: string, script: string, opts?: ExecRequest) => ExecReply | undefined;
}

const ok = (stdout = "", exitCode = 0, stderr = ""): ExecReply => ({
  exitCode,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
});

export class FakeOpenShell implements OpenShellClientLike {
  readonly calls: Call[] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly interactives: FakeInteractive[] = [];
  readonly execs: { name: string; script: string; opts?: ExecRequest }[] = [];
  closedForwards = 0;
  #port = 41000;

  constructor(public options: FakeOptions = {}) {}

  #need(name: string): FakeSandbox {
    const sb = this.sandboxes.get(name);
    if (!sb) throw new SdkLikeError("not_found", `sandbox ${name} not found`);
    return sb;
  }

  async create(spec: CreateSpec): Promise<SandboxInfo> {
    this.calls.push({ op: "create", name: spec.name, detail: spec });
    if (this.options.createError) throw this.options.createError;
    checkLabels(spec.labels);
    if (this.sandboxes.has(spec.name)) throw new SdkLikeError("already_exists", "exists");
    this.sandboxes.set(spec.name, { phase: "provisioning", labels: { ...spec.labels }, files: new Map(), spec });
    if (this.options.createThenThrow) throw this.options.createThenThrow;
    return { name: spec.name, phase: "provisioning", labels: { ...spec.labels } };
  }

  async get(name: string): Promise<SandboxInfo> {
    this.calls.push({ op: "get", name });
    const sb = this.#need(name);
    return { name, phase: sb.phase, labels: { ...sb.labels } };
  }

  async listAll(options?: { labelSelector?: string }): Promise<SandboxInfo[]> {
    this.calls.push({ op: "list", name: "", detail: options });
    const [k, v] = (options?.labelSelector ?? "").split("=");
    return [...this.sandboxes.entries()]
      .filter(([, sb]) => !k || sb.labels[k] === v)
      .map(([name, sb]) => ({ name, phase: sb.phase, labels: { ...sb.labels } }));
  }

  async waitReady(name: string): Promise<unknown> {
    this.calls.push({ op: "waitReady", name });
    if (this.options.waitReadyError) throw this.options.waitReadyError;
    this.#need(name).phase = "ready";
    return {};
  }

  async delete(name: string, options?: { allowMissing?: boolean }): Promise<unknown> {
    this.calls.push({ op: "delete", name });
    if ((this.options.deleteFailures ?? 0) > 0) {
      this.options.deleteFailures = (this.options.deleteFailures ?? 0) - 1;
      throw new SdkLikeError("rpc", "transient delete failure");
    }
    if (!this.sandboxes.delete(name) && !options?.allowMissing) {
      throw new SdkLikeError("not_found", "missing");
    }
    return {};
  }

  async waitDeleted(name: string): Promise<void> {
    this.calls.push({ op: "waitDeleted", name });
  }

  async exec(name: string, command: string[], opts?: ExecRequest): Promise<ExecReply> {
    const sb = this.#need(name);
    const script = command[2] ?? "";
    this.execs.push({ name, script, ...(opts ? { opts } : {}) });
    this.calls.push({ op: "exec", name, detail: script });
    const custom = this.options.onExec?.(name, script, opts);
    if (custom) return custom;
    if (script === "pwd") return ok("/sandbox\n");
    let m = /^mkdir -p '[^']*' && cat > '([^']*)'$/.exec(script);
    if (m?.[1]) {
      sb.files.set(m[1], Buffer.from(opts?.stdin ?? Buffer.alloc(0)));
      return ok();
    }
    m = /^cat >> '([^']*)'$/.exec(script);
    if (m?.[1]) {
      sb.files.set(m[1], Buffer.concat([sb.files.get(m[1]) ?? Buffer.alloc(0), opts?.stdin ?? Buffer.alloc(0)]));
      return ok();
    }
    m = /^\[ -e '([^']*)' \] \|\| exit 44; \[ -d '[^']*' \] && exit 45; cat -- /.exec(script);
    if (m?.[1]) {
      const data = sb.files.get(m[1]);
      return data ? { exitCode: 0, stdout: data, stderr: Buffer.alloc(0) } : ok("", 44);
    }
    return ok();
  }

  async execInteractive(name: string, command: string[], opts?: ExecRequest): Promise<InteractiveControl> {
    this.#need(name);
    this.calls.push({ op: "execInteractive", name, detail: { script: command[2], opts } });
    const ctl = new FakeInteractive();
    this.interactives.push(ctl);
    return ctl;
  }

  async forward(name: string, options: { targetPort: number }) {
    this.#need(name);
    this.calls.push({ op: "forward", name, detail: options.targetPort });
    return {
      localHost: "127.0.0.1",
      localPort: this.#port++,
      close: (): Promise<void> => {
        this.closedForwards++;
        return Promise.resolve();
      },
    };
  }

  ops(): string[] {
    return this.calls.filter((c) => c.op !== "exec").map((c) => c.op);
  }
}

/** Assert a value is present (tests avoid non-null assertions). */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

/** Minimal policy for tests (avoids reading the policy file). */
export const TEST_POLICY = { version: 1, networkPolicies: {} };
