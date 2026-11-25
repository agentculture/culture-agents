// Harness-neutral sandbox surface. Other core modules import these types only;
// nothing here mentions the AI SDK or the OpenShell SDK.

export interface ExecOptions {
  /** Working directory; relative paths resolve against the sandbox home. */
  readonly cwd?: string;
  /** Extra environment. GH_TOKEN, GITHUB_TOKEN and SSH_AUTH_SOCK are always dropped. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Keep stdin open for `write`; otherwise it is closed at once. */
  readonly stdin?: boolean;
  /** Aborting cancels the process. */
  readonly signal?: AbortSignal;
}

export interface RunProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Write to stdin; throws when the process was spawned without stdin. */
  write(data: Uint8Array): void;
  closeInput(): void;
  /** Resolves when the remote process ends. A cancelled process reports 137 when no code arrives. */
  wait(): Promise<{ exitCode: number }>;
  /** End the remote process. Idempotent. */
  cancel(): Promise<void>;
}

/** A host-side TCP endpoint that tunnels to a port inside the sandbox. */
export interface PortEndpoint {
  readonly host: string;
  readonly port: number;
}

export type RunSandboxState = "ready" | "stopped" | "destroyed";

/** One run's sandbox. Obtained from {@link RunSandboxes}; never constructed directly. */
export interface RunSandbox {
  readonly runId: string;
  /** Sandbox name on the gateway (deterministic from the run id). */
  readonly name: string;
  /** The sandbox's home / default working directory, read from the live sandbox. */
  readonly home: string;
  readonly state: RunSandboxState;
  /** Run a shell script (`sh -c`) to completion. */
  exec(script: string, options?: ExecOptions): Promise<ExecResult>;
  /** File bytes, or null when the path does not exist. */
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | null>;
  /** Write bytes, creating parent directories. Large contents are sent in chunks. */
  writeFile(path: string, content: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
  spawn(command: string, options?: SpawnOptions): Promise<RunProcess>;
  /** Forward a host loopback port to `port` in the sandbox (reused per port). */
  endpoint(port: number): Promise<PortEndpoint>;
  /** Cancel tracked processes and close forwards; the sandbox stays on the gateway. */
  stop(): Promise<void>;
  /** Stop, then delete the sandbox and wait until the gateway reports it gone. Idempotent. */
  destroy(): Promise<void>;
}

export interface RunSandboxes {
  /**
   * Create and wait for the run's sandbox. If anything after the create call
   * fails (readiness, abort, binding), the sandbox is deleted before the error
   * propagates. Refuses a run id that already has a live sandbox in this process.
   */
  create(runId: string, options?: { signal?: AbortSignal }): Promise<RunSandbox>;
  /** Rebind to the run's existing sandbox (another process may have created it). */
  resume(runId: string, options?: { signal?: AbortSignal }): Promise<RunSandbox>;
  /**
   * Delete the run's sandbox by run id alone, whoever created it. Works when no
   * handle exists (crash recovery, a leaked adapter session). Idempotent.
   */
  destroy(runId: string): Promise<void>;
  /** Create, run `fn`, and always destroy, whether `fn` resolves or throws. */
  withRun<T>(runId: string, fn: (sandbox: RunSandbox) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  /** Run ids with a live sandbox handle in this process. */
  active(): string[];
  /**
   * Delete every sandbox this core manages (by label and prefix) whose run id is
   * not in `keep`. With `only`, sandboxes of other run ids are left alone, so a core that shares
   * a gateway with another core reclaims its own runs and nothing else. Returns the deleted run ids.
   */
  sweep(keep?: Iterable<string>, only?: Iterable<string>): Promise<string[]>;
}

export interface RunSandboxesConfig {
  /** Container image with git, Node and the harness CLIs. */
  readonly image: string;
  /** Names of credential providers already configured on the gateway. */
  readonly providers?: readonly string[];
  /** Sandbox-name prefix (default `ca-`). */
  readonly prefix?: string;
  /** Path to an authored policy JSON file; default `core/policy/run-sandbox.policy.json`. */
  readonly policyPath?: string;
  readonly readyTimeoutSecs?: number;
  readonly deleteTimeoutSecs?: number;
  /** Overall bound on one deletion, every attempt and wait together (default 90 s). */
  readonly deleteDeadlineMs?: number;
  /** Diagnostics hook; receives no secrets. */
  readonly log?: (message: string) => void;
}

/** Thrown by `create` when this process already holds a live sandbox for the run. */
export class SandboxBusyError extends Error {
  override readonly name = "SandboxBusyError";
}

/** Thrown when `resume` finds no sandbox, or one whose run-id label does not match. */
export class SandboxNotFoundError extends Error {
  override readonly name = "SandboxNotFoundError";
}

/** Thrown when deletion could not be confirmed; the run id stays queued for `sweep`. */
export class SandboxCleanupError extends Error {
  override readonly name = "SandboxCleanupError";
}
