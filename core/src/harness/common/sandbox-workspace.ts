/**
 * A `Workspace` on one OpenShell run sandbox: create the sandbox, hand the repository in as a
 * git bundle (`prepare`), commit what the harness changed, fetch the run's commits to the host
 * over SSH (`collect`), and delete the sandbox. The sandbox layer does the work; this file only
 * sequences it and makes every step safe to repeat on failure paths.
 */
import { posix } from "node:path";

import {
  collect as collectTree,
  openRunSandboxes,
  prepare as prepareTree,
  type CollectOptions,
  type CollectedTree,
  type GatewayOptions,
  type PrepareOptions,
  type PreparedTree,
  type RunSandbox,
  type RunSandboxes,
  type RunSandboxesConfig,
} from "../../sandbox/index.js";
import { withTimeout } from "../../sandbox/timeout.js";
import { PS_SCRIPT, parsePs } from "./processes.js";
import type { Collected, Proc, Workspace, WorkspaceFactory } from "./types.js";

/** JSON-serializable sandbox settings (part of a driver's options). */
export interface SandboxSettings {
  gateway: { endpoint: string; tlsDir: string | null; name: string | null };
  openshellBin: string;
  image: string;
  providers: string[];
  sandboxPrefix: string;
  /** Host ref the run starts from. */
  ref: string;
  identity: { name: string; email: string };
  /** Days the sandbox is kept when a completed turn's commit or collect fails; 0 keeps nothing. Default 7. */
  retainFailedSandboxDays?: number;
}

/** Injectable sandbox-layer calls (tests replace them). */
export interface SandboxDeps {
  /** Overall bound on deleting the run's sandbox (tests shorten it). Default DESTROY_DEADLINE_MS. */
  destroyDeadlineMs?: number;
  openRunSandboxes(config: RunSandboxesConfig, gateway: GatewayOptions): Promise<RunSandboxes>;
  prepare(sandbox: RunSandbox, options: PrepareOptions): Promise<PreparedTree>;
  collect(sandbox: RunSandbox, options: CollectOptions): Promise<CollectedTree>;
}

/**
 * Longest deleting the run's sandbox may take in all, the fallback by run id included. The run
 * waits in `cancelling` (or short of its terminal event) for this, so it is one deadline. A
 * sandbox that outlives it is deleted later by the daemon's periodic reclaim of finished runs.
 */
export const DESTROY_DEADLINE_MS = 90_000;
/** Longest a commit or a commit count inside the sandbox may take. */
const COMMIT_TIMEOUT_MS = 120_000;
/** Longest a process listing or kill inside the sandbox may take. */
const PROCESS_TIMEOUT_MS = 30_000;

export const realSandboxDeps: SandboxDeps = { openRunSandboxes, prepare: prepareTree, collect: collectTree };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
/** A single quote inside a single-quoted shell word: close the word, an escaped quote, open it again. */
const ESCAPED_QUOTE = String.raw`'\''`;
export const shq = (s: string) => `'${s.replaceAll("'", ESCAPED_QUOTE)}'`;

export class SandboxWorkspace implements Workspace {
  private destroyed: Promise<void> | null = null;

  constructor(
    private readonly sandboxes: RunSandboxes,
    readonly sandbox: RunSandbox,
    readonly prepared: PreparedTree,
    private readonly runId: string,
    private readonly hostRepo: string,
    private readonly settings: SandboxSettings,
    private readonly deps: SandboxDeps,
  ) {}

  get workdir(): string {
    return this.prepared.path;
  }

  /** The working tree relative to the sandbox home (what the AI SDK calls `workDir`). */
  get relativeWorkdir(): string {
    return posix.relative(this.sandbox.home, this.prepared.path) || ".";
  }

  async processes(): Promise<Proc[]> {
    const res = await withTimeout("listing the sandbox's processes", PROCESS_TIMEOUT_MS, (signal) => this.sandbox.exec(PS_SCRIPT, { signal }));
    if (res.exitCode !== 0) throw new Error(`ps failed (exit ${res.exitCode}): ${text(res.stderr).trim()}`);
    return parsePs(text(res.stdout));
  }

  async kill(pids: readonly number[]): Promise<void> {
    const list = pids.filter((p) => Number.isInteger(p) && p > 1).join(" ");
    if (list) await withTimeout("killing processes in the sandbox", PROCESS_TIMEOUT_MS, (signal) => this.sandbox.exec(`kill -9 ${list} 2>/dev/null; true`, { signal }));
  }

  async commitAll(message: string): Promise<number> {
    const w = shq(this.workdir);
    const script =
      // The clone's git config belongs to the harness: hooks (`--no-verify` skips only two of them)
      // and a file-system monitor it left behind must not run, or hang, in the core's own commit.
      `set -e; cd ${w}; g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }; g add -A; ` +
      `if ! g diff --cached --quiet; then g commit -q --no-verify -m ${shq(message)}; fi; ` +
      `g rev-list --count ${shq(this.prepared.baseCommit)}..HEAD`;
    const res = await withTimeout("committing the run's changes in the sandbox", COMMIT_TIMEOUT_MS, (signal) => this.sandbox.exec(script, { signal }));
    if (res.exitCode !== 0) throw new Error(`commit in sandbox failed (exit ${res.exitCode}): ${text(res.stderr).trim()}`);
    const count = Number(text(res.stdout).trim().split("\n").pop());
    if (!Number.isInteger(count)) throw new Error("could not count the run's commits");
    return count;
  }

  async collect(): Promise<Collected | null> {
    const count = await this.commitCount();
    if (count === 0) return null;
    const options: CollectOptions = {
      hostRepo: this.hostRepo,
      runId: this.runId,
      remotePath: this.prepared.path,
      baseCommit: this.prepared.baseCommit,
      openshellBin: this.settings.openshellBin,
      ...(this.settings.gateway.name ? { gatewayName: this.settings.gateway.name } : {}),
    };
    const tree = await this.deps.collect(this.sandbox, options);
    return { branch: tree.branch, commit: tree.commit, commits: count, shas: tree.commits };
  }

  private async commitCount(): Promise<number> {
    const count = `cd ${shq(this.workdir)} && git rev-list --count ${shq(this.prepared.baseCommit)}..HEAD`;
    const res = await withTimeout("counting the run's commits in the sandbox", COMMIT_TIMEOUT_MS, (signal) => this.sandbox.exec(count, { signal }));
    return res.exitCode === 0 ? Number(text(res.stdout).trim()) : 0;
  }

  retention(): { sandbox: string; recover: string } {
    const gateway = this.settings.gateway.name ? `-g ${this.settings.gateway.name} ` : "";
    const branch = this.prepared.branch;
    return {
      sandbox: this.sandbox.name,
      recover:
        `run \`${this.settings.openshellBin} ${gateway}sandbox ssh-config ${this.sandbox.name} > ca-ssh.cfg\`, then in ${this.hostRepo} ` +
        `\`GIT_SSH_COMMAND='ssh -F ca-ssh.cfg' git fetch ssh://<the Host name in ca-ssh.cfg>${this.prepared.path} ${branch}:${branch}\`. ` +
        `Changes that were never committed are in the sandbox's working tree ${this.prepared.path}.`,
    };
  }

  /** Close the forwards and tracked processes; the sandbox stays on the gateway. */
  async keep(): Promise<void> {
    await this.sandbox.stop();
  }

  destroy(): Promise<void> {
    this.destroyed ??= withTimeout(`deleting sandbox ${this.sandbox.name}`, this.deps.destroyDeadlineMs ?? DESTROY_DEADLINE_MS, () =>
      this.sandbox.destroy().catch(async (err: unknown) => {
        // The handle failed; delete by run id alone, which needs no handle.
        await this.sandboxes.destroy(this.runId).catch(() => {
          throw err;
        });
      }),
    );
    return this.destroyed;
  }
}

export class SandboxWorkspaceFactory implements WorkspaceFactory<SandboxWorkspace> {
  constructor(
    private readonly runId: string,
    private readonly hostRepo: string,
    private readonly settings: SandboxSettings,
    private readonly deps: SandboxDeps = realSandboxDeps,
    /** The commit recorded when the submit was accepted; the sandbox is built from it, not from `settings.ref`. */
    private readonly baseCommit?: string,
  ) {}

  async open(signal: AbortSignal): Promise<SandboxWorkspace> {
    const s = this.settings;
    const gateway: GatewayOptions = { gateway: s.gateway.endpoint, ...(s.gateway.tlsDir ? { tlsDir: s.gateway.tlsDir } : {}) };
    const sandboxes = await this.deps.openRunSandboxes({ image: s.image, providers: s.providers, prefix: s.sandboxPrefix }, gateway);
    const sandbox = await sandboxes.create(this.runId, { signal });
    try {
      const prepared = await this.deps.prepare(sandbox, {
        hostRepo: this.hostRepo,
        ref: this.baseCommit ?? s.ref,
        runId: this.runId,
        identity: s.identity,
        signal,
      });
      return new SandboxWorkspace(sandboxes, sandbox, prepared, this.runId, this.hostRepo, s, this.deps);
    } catch (err) {
      const deadline = this.deps.destroyDeadlineMs ?? DESTROY_DEADLINE_MS;
      await withTimeout(`deleting sandbox ${sandbox.name}`, deadline, () => sandbox.destroy().catch(() => sandboxes.destroy(this.runId))).catch(() => undefined);
      throw err;
    }
  }
}
