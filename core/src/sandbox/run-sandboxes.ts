// Run-scoped sandbox lifecycle over OpenShell. Deletion on terminal state is
// ours: the AI SDK's HarnessAgent leaks a provider-created sandbox when the
// adapter's start fails (docs/d0/probe.md, obstacle 7), so every path here
// either returns a tracked handle or deletes what it created, and any run's
// sandbox can be deleted from its run id alone.
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

  /** Delete with retries, then wait until the gateway reports the sandbox gone. */
  readonly #deleteByName = async (name: string, runId: string): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt++) {
      try {
        await withTimeout(`asking the gateway to delete sandbox ${name}`, DELETE_CALL_TIMEOUT_MS, () => this.client.delete(name, { allowMissing: true }));
        await this.client
          .waitDeleted(name, this.config.deleteTimeoutSecs ?? 120)
          .catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        this.#pendingCleanup.delete(runId);
        this.#log(`deleted sandbox ${name} (run ${runId})`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < DELETE_ATTEMPTS) await this.#sleep(250 * attempt);
      }
    }
    this.#pendingCleanup.add(runId);
    throw new SandboxCleanupError(
      `could not confirm deletion of sandbox ${name} (run ${runId}): ${(lastError as Error)?.message}`,
      { cause: lastError },
    );
  };

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
    for (const runId of doomed) {
      if (kept.has(runId) || this.#live.has(runId)) continue;
      if (wanted !== null && !wanted.has(runId)) continue;
      try {
        await this.destroy(runId);
        deleted.push(runId);
      } catch (error) {
        // Keep going; a failed run id stays queued for the next sweep.
        this.#log(`sweep: run ${runId}: ${(error as Error).message}`);
      }
    }
    return deleted;
  }
}

/** Run-scoped sandboxes on an OpenShell gateway. */
export function createRunSandboxes(config: RunSandboxesConfig, deps: RunSandboxesDeps): RunSandboxes {
  return new OpenShellRunSandboxes(config, deps.client, deps);
}
