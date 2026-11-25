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
}

/** Injectable sandbox-layer calls (tests replace them). */
export interface SandboxDeps {
  openRunSandboxes(config: RunSandboxesConfig, gateway: GatewayOptions): Promise<RunSandboxes>;
  prepare(sandbox: RunSandbox, options: PrepareOptions): Promise<PreparedTree>;
  collect(sandbox: RunSandbox, options: CollectOptions): Promise<CollectedTree>;
}

export const realSandboxDeps: SandboxDeps = { openRunSandboxes, prepare: prepareTree, collect: collectTree };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

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
    const res = await this.sandbox.exec(PS_SCRIPT);
    if (res.exitCode !== 0) throw new Error(`ps failed (exit ${res.exitCode}): ${text(res.stderr).trim()}`);
    return parsePs(text(res.stdout));
  }

  async kill(pids: readonly number[]): Promise<void> {
    const list = pids.filter((p) => Number.isInteger(p) && p > 1).join(" ");
    if (list) await this.sandbox.exec(`kill -9 ${list} 2>/dev/null; true`);
  }

  async commitAll(message: string): Promise<number> {
    const w = shq(this.workdir);
    const script =
      `set -e; cd ${w}; git add -A; ` +
      `if ! git diff --cached --quiet; then git commit -q --no-verify -m ${shq(message)}; fi; ` +
      `git rev-list --count ${shq(this.prepared.baseCommit)}..HEAD`;
    const res = await this.sandbox.exec(script);
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
    const res = await this.sandbox.exec(`cd ${shq(this.workdir)} && git rev-list --count ${shq(this.prepared.baseCommit)}..HEAD`);
    return res.exitCode === 0 ? Number(text(res.stdout).trim()) : 0;
  }

  destroy(): Promise<void> {
    this.destroyed ??= this.sandbox.destroy().catch(async (err: unknown) => {
      // The handle failed; delete by run id alone, which needs no handle.
      await this.sandboxes.destroy(this.runId).catch(() => {
        throw err;
      });
    });
    return this.destroyed;
  }
}

export class SandboxWorkspaceFactory implements WorkspaceFactory<SandboxWorkspace> {
  constructor(
    private readonly runId: string,
    private readonly hostRepo: string,
    private readonly settings: SandboxSettings,
    private readonly deps: SandboxDeps = realSandboxDeps,
  ) {}

  async open(signal: AbortSignal): Promise<SandboxWorkspace> {
    const s = this.settings;
    const gateway: GatewayOptions = { gateway: s.gateway.endpoint, ...(s.gateway.tlsDir ? { tlsDir: s.gateway.tlsDir } : {}) };
    const sandboxes = await this.deps.openRunSandboxes({ image: s.image, providers: s.providers, prefix: s.sandboxPrefix }, gateway);
    const sandbox = await sandboxes.create(this.runId, { signal });
    try {
      const prepared = await this.deps.prepare(sandbox, {
        hostRepo: this.hostRepo,
        ref: s.ref,
        runId: this.runId,
        identity: s.identity,
        signal,
      });
      return new SandboxWorkspace(sandboxes, sandbox, prepared, this.runId, this.hostRepo, s, this.deps);
    } catch (err) {
      await sandbox.destroy().catch(() => sandboxes.destroy(this.runId).catch(() => undefined));
      throw err;
    }
  }
}
