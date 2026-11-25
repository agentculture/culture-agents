// Run-scoped sandbox lifecycle over OpenShell. Deletion on terminal state is
// ours: the AI SDK's HarnessAgent leaks a provider-created sandbox when the
// adapter's start fails (docs/d0/probe.md, obstacle 7), so every path here
// either returns a tracked handle or deletes what it created, and any run's
// sandbox can be deleted from its run id alone.
import { again, finish, inOrder, stepUntil } from "../util/sequence.js";
import { withTimeout } from "./timeout.js";
import {
  isAlreadyExists,
  isNotFound,
  type OpenShellClientLike,
  type SandboxPolicyInit,
} from "./openshell-client.js";
import {
  DEFAULT_PREFIX,
  LABEL_MANAGED_BY,
  LABEL_MANAGED_BY_VALUE,
  labelsMatchRun,
  runIdFromLabels,
  runLabels,
  sandboxName,
  validatePrefix,
  validateRunId,
} from "./naming.js";
import { DEFAULT_POLICY_PATH, loadPolicyFile } from "./policy.js";
import { OpenShellRunSandbox } from "./run-sandbox.js";
import {
  SandboxBusyError,
  SandboxCleanupError,
  SandboxNotFoundError,
  type RunSandbox,
  type RunSandboxes,
  type RunSandboxesConfig,
} from "./types.js";

const DELETE_ATTEMPTS = 3;
/** Longest one delete request to the gateway may take; the wait for the sandbox to be gone is bounded separately. */
const DELETE_CALL_TIMEOUT_MS = 30_000;
/**
 * Longest one deletion may take in all: every attempt, pause and wait together. A run is held in
 * `cancelling` (or short of its terminal event) while its sandbox is deleted, so this is one
 * deadline, not one per attempt. A sandbox that outlives it stays queued and is deleted later by
 * `sweep` (the daemon's periodic reclaim of finished runs).
 */
export const DELETE_DEADLINE_MS = 90_000;

export interface RunSandboxesDeps {
  readonly client: OpenShellClientLike;
  /** Pause between delete retries; injectable so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Pre-loaded policy (tests); otherwise read from `config.policyPath`. */
  readonly policy?: SandboxPolicyInit;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class OpenShellRunSandboxes implements RunSandboxes {
  readonly #live = new Map<string, OpenShellRunSandbox>();
  /** Run ids whose deletion failed; retried by sweep(). */
  readonly #pendingCleanup = new Set<string>();
  readonly #prefix: string;
  readonly #policy: SandboxPolicyInit;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: RunSandboxesConfig,
    private readonly client: OpenShellClientLike,
    deps: RunSandboxesDeps,
  ) {
    this.#prefix = validatePrefix(config.prefix ?? DEFAULT_PREFIX);
    this.#policy = deps.policy ?? loadPolicyFile(config.policyPath ?? DEFAULT_POLICY_PATH);
    this.#sleep = deps.sleep ?? realSleep;
  }

  #log(message: string): void {
    this.config.log?.(message);
  }

  /** Delete with retries, then wait until the gateway reports the sandbox gone, all within one overall deadline. */
  readonly #deleteByName = async (name: string, runId: string): Promise<void> => {
    const budget = this.config.deleteDeadlineMs ?? DELETE_DEADLINE_MS;
    const deadline = Date.now() + budget;
    const left = () => deadline - Date.now();
    let lastError: unknown = new Error("the deadline passed before the gateway was asked");
    let attempt = 1;
    // One attempt at a time. A failed one is followed by a growing pause while attempts and time are left.
    const deleted = await stepUntil<boolean>(
      async () => {
        if (!(attempt <= DELETE_ATTEMPTS && left() > 0)) return finish(false);
        try {
          await this.#deleteOnce(name, runId, left);
          return finish(true);
        } catch (error) {
          lastError = error;
          const pause = attempt < DELETE_ATTEMPTS && left() > 0 ? Math.min(250 * attempt, Math.max(0, left())) : undefined;
          attempt += 1;
          return again(pause);
        }
      },
      { wait: this.#sleep },
    );
    if (deleted) return;
    this.#pendingCleanup.add(runId);
    throw new SandboxCleanupError(
      `could not confirm deletion of sandbox ${name} (run ${runId}) within the overall deadline of ${Math.round(budget / 1000)} s: ${(lastError as Error)?.message}`,
      { cause: lastError },
    );
  };

  /** One delete and the wait for it to take effect, within what `left` says remains of the deadline. */
  async #deleteOnce(name: string, runId: string, left: () => number): Promise<void> {
    await withTimeout(`asking the gateway to delete sandbox ${name}`, Math.min(DELETE_CALL_TIMEOUT_MS, left()), () => this.client.delete(name, { allowMissing: true }));
    // The wait gets the time left, both as its own timeout and as a bound on a wait that ignores it.
    const waitMs = Math.max(1, left());
    const waitSecs = Math.max(1, Math.min(this.config.deleteTimeoutSecs ?? 120, Math.ceil(waitMs / 1000)));
    await withTimeout(`waiting for sandbox ${name} to be gone`, waitMs, () => this.client.waitDeleted(name, waitSecs)).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    this.#pendingCleanup.delete(runId);
    this.#log(`deleted sandbox ${name} (run ${runId})`);
  }

  async #bind(runId: string, name: string, signal?: AbortSignal): Promise<OpenShellRunSandbox> {
    const probe = await this.client.exec(name, ["sh", "-c", "pwd"], {
      noLoginShell: true,
      ...(signal ? { signal } : {}),
    });
    const home = probe.stdout.toString("utf8").trim() || "/sandbox";
    const sandbox = new OpenShellRunSandbox(
      runId,
      name,
      home,
      this.client,
      this.#deleteByName,
      () => this.#live.delete(runId),
      this.config.log,
    );
    this.#live.set(runId, sandbox);
    return sandbox;
  }

  async create(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunSandbox> {
    const name = sandboxName(validateRunId(runId), this.#prefix);
    if (this.#live.has(runId)) throw new SandboxBusyError(`run ${runId} already has a live sandbox`);
    options.signal?.throwIfAborted();
    const t0 = Date.now();
    try {
      await this.client.create({
        name,
        image: this.config.image,
        providers: [...(this.config.providers ?? [])],
        labels: runLabels(runId),
        policy: this.#policy,
      });
    } catch (error) {
      // Someone else's sandbox already holds the name: never delete it.
      if (isAlreadyExists(error)) {
        throw new SandboxBusyError(`sandbox ${name} for run ${runId} already exists`, { cause: error });
      }
      // The gateway may have created it before the call failed (timeout, drop).
      await this.#cleanupAfterFailure(name, runId, error);
      throw error;
    }
    try {
      await this.client.waitReady(name, this.config.readyTimeoutSecs ?? 180, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      options.signal?.throwIfAborted();
      const sandbox = await this.#bind(runId, name, options.signal);
      options.signal?.throwIfAborted();
      this.#log(`sandbox ${name} ready for run ${runId} in ${Date.now() - t0} ms`);
      return sandbox;
    } catch (error) {
      this.#live.delete(runId);
      await this.#cleanupAfterFailure(name, runId, error);
      throw error;
    }
  }

  async #cleanupAfterFailure(name: string, runId: string, cause: unknown): Promise<void> {
    try {
      await this.#deleteByName(name, runId);
    } catch (cleanupError) {
      this.#log(
        `run ${runId}: create failed (${(cause as Error)?.message}) and cleanup failed ` +
          `(${(cleanupError as Error).message}); queued for sweep`,
      );
    }
  }

  async resume(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunSandbox> {
    const name = sandboxName(validateRunId(runId), this.#prefix);
    const existing = this.#live.get(runId);
    if (existing) return existing;
    let info;
    try {
      info = await this.client.get(name);
    } catch (error) {
      if (isNotFound(error)) throw new SandboxNotFoundError(`no sandbox for run ${runId}`, { cause: error });
      throw error;
    }
    if (!labelsMatchRun(info.labels, runId)) {
      throw new SandboxNotFoundError(
        `sandbox ${name} belongs to run ${JSON.stringify(runIdFromLabels(info.labels))}, not ${runId}`,
      );
    }
    if (info.phase !== "ready") {
      await this.client.waitReady(name, this.config.readyTimeoutSecs ?? 180, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    return this.#bind(runId, name, options.signal);
  }

  async destroy(runId: string): Promise<void> {
    const live = this.#live.get(runId);
    if (live) return live.destroy();
    return this.#deleteByName(sandboxName(validateRunId(runId), this.#prefix), runId);
  }

  async withRun<T>(
    runId: string,
    fn: (sandbox: RunSandbox) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const sandbox = await this.create(runId, options);
    let result: T;
    try {
      result = await fn(sandbox);
    } catch (error) {
      await this.destroy(runId).catch((cleanupError: unknown) =>
        this.#log(`run ${runId}: cleanup after failure failed: ${(cleanupError as Error).message}`),
      );
      throw error;
    }
    await this.destroy(runId);
    return result;
  }

  active(): string[] {
    return [...this.#live.keys()];
  }

  async sweep(keep: Iterable<string> = [], only?: Iterable<string>): Promise<string[]> {
    const kept = new Set(keep);
    const wanted = only === undefined ? null : new Set(only);
    const all = await this.client.listAll({
      labelSelector: `${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE}`,
    });
    const doomed = new Set<string>(this.#pendingCleanup);
    for (const info of all) {
      const runId = runIdFromLabels(info.labels);
      if (info.labels[LABEL_MANAGED_BY] !== LABEL_MANAGED_BY_VALUE || !runId) continue;
      if (!info.name.startsWith(this.#prefix)) continue;
      doomed.add(runId);
    }
    const deleted: string[] = [];
    await inOrder(doomed, async (runId) => {
      if (kept.has(runId) || this.#live.has(runId)) return;
      if (wanted !== null && !wanted.has(runId)) return;
      try {
        await this.destroy(runId);
        deleted.push(runId);
      } catch (error) {
        // Keep going; a failed run id stays queued for the next sweep.
        this.#log(`sweep: run ${runId}: ${(error as Error).message}`);
      }
    });
    return deleted;
  }
}

/** Run-scoped sandboxes on an OpenShell gateway. */
export function createRunSandboxes(config: RunSandboxesConfig, deps: RunSandboxesDeps): RunSandboxes {
  return new OpenShellRunSandboxes(config, deps.client, deps);
}
