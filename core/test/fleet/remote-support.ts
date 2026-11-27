// Shared plumbing for the remote-run tests (t23). Each core is in-process: a fleet (listener, member
// list, announcer, remote calls) on loopback plus a control-socket daemon, both of thor's fixture.
// The executing core is named thor. Two members never share a node name (c40), so the calling core
// and a third member use length-boundary filler (CALLER_NODE, OTHER_NODE) that names no host.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { join } from "node:path";

import {
  buildRunId,
  newUlid,
  type Allowlist,
  type Run,
  type RunEvent,
  type RunResult,
  type SubmitRequest,
  type SubmitResponse,
  type Submitter,
} from "../../src/contract/index.js";
import { loadAllowlist } from "../../src/daemon/allowlist.js";
import { startDaemon, type Daemon } from "../../src/daemon/daemon.js";
import type { SubmitOptions } from "../../src/daemon/ports.js";
import { certificateFor, newFleetKey } from "../../src/fleet/cert.js";
import type { FleetConfig } from "../../src/fleet/config.js";
import { createFleet, type Fleet } from "../../src/fleet/index.js";
import { loadTrust } from "../../src/fleet/trust.js";
import { hostEnv } from "../../src/sandbox/host-command.js";
import { FakeRunService, fixture, stream } from "../daemon/fake-service.js";
import { makeEnv, type Env } from "../daemon/harness.js";
import { GIT } from "../harness/helpers.js";
import { LOOPBACK } from "./support.js";

export const CALLER_NODE = "xxxxxxxx";
export const OTHER_NODE = "yyyyyyyy";
export const AGENT = "thor-culture-agents";
export const ALIAS = "culture-agents";
const FIXTURE_RUN = "thor-culture-agents.run.01JDQ5V7M2K8X9Y0Z1A2B3C4D5";

export interface Received {
  request: SubmitRequest;
  submitter: Submitter | undefined;
  options: SubmitOptions | undefined;
}

/** The executing core's run service: records each submit and keeps the run, as the real service would. */
export class MemberService extends FakeRunService {
  readonly received: Received[] = [];
  /** The branch and commits `getResult` reports for a run (t26); the fixture's otherwise. */
  readonly results = new Map<string, Pick<RunResult, "branch" | "commits">>();

  constructor(private readonly clock: () => Date) {
    super();
  }

  override async getResult(runId: string): Promise<RunResult> {
    const result = await super.getResult(runId);
    return { ...result, ...this.results.get(runId) };
  }

  override submit(request: SubmitRequest, submitter?: Submitter, options?: SubmitOptions): Promise<SubmitResponse> {
    this.calls.push("submit");
    this.received.push({ request, submitter, options });
    const created = this.clock();
    const base = fixture<Run>("valid/run/root.queued.json");
    const id = buildRunId(request.agent_id, newUlid(created.getTime()));
    const run: Run = {
      ...base,
      id,
      agent_id: request.agent_id,
      harness: request.harness,
      repo: request.repo,
      task: request.task,
      owner: request.caller,
      ...(submitter && { submitter }),
      base_commit: options?.baseRef ?? "3f2a9c0d1e4b5a6978c0d1e2f3a4b5c6d7e8f901",
      deadline: request.deadline ?? null,
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
    };
    this.seed(run, eventsOf("steered-then-succeeded.jsonl", id).slice(0, 1));
    return Promise.resolve({ run });
  }
}

/** A fixture stream's events, as events of run `id`. */
export function eventsOf(name: string, id: string): RunEvent[] {
  return stream(name).map((e) => JSON.parse(JSON.stringify(e).replaceAll(FIXTURE_RUN, id)) as RunEvent);
}

export interface Core {
  node: string;
  key: KeyObject;
  env: Env;
  fleetDir: string;
  fleet: Fleet;
  daemon: Daemon;
  service: MemberService;
  logs: string[];
  port(): number;
  /** Write this core's address list. */
  announceTo(...targets: Core[]): void;
  stop(): Promise<void>;
}

export interface CoreOptions {
  /** The API version this core reports (default: this build's). */
  apiVersion?: string;
  /** This core's wall clock (default: the real one). */
  now?: () => Date;
  /** `[alias, path]` pairs of the alias file. */
  aliases?: [string, string][];
  /** Allow-list entries. */
  allowlist?: Allowlist["entries"];
}

/** A started core named `node` holding `key`, trusting each `[name, key]`. */
export async function startCore(node: string, key: KeyObject, trusted: readonly [string, KeyObject][], o: CoreOptions = {}): Promise<Core> {
  const env = makeEnv();
  const fleetDir = join(env.configHome, "culture-agents", "fleet");
  mkdirSync(fleetDir, { recursive: true });
  const trustPath = join(fleetDir, "trust.json");
  writeFileSync(trustPath, JSON.stringify(trusted.map(([name, k]) => ({ node: name, cert: certificateFor(k).text }))));
  if (o.aliases) writeFileSync(join(fleetDir, "aliases.json"), JSON.stringify({ version: 1, aliases: o.aliases.map(([alias, repo]) => ({ alias, repo })) }));
  mkdirSync(join(env.configHome, "culture-agents"), { recursive: true });
  writeFileSync(env.allowlistPath, JSON.stringify({ version: 1, entries: o.allowlist ?? [] }));
  const now = o.now ?? (() => new Date());
  const service = new MemberService(now);
  const config: FleetConfig = { host: LOOPBACK, port: 0, key, trustPath, trust: loadTrust(trustPath), peersPath: join(fleetDir, "peers.json") };
  const logs: string[] = [];
  const fleet = createFleet(config, node, (l) => logs.push(l), { intervalMs: 3_600_000, ...(o.apiVersion !== undefined && { apiVersion: o.apiVersion }) }, { service, allowlist: () => loadAllowlist(env.allowlistPath), now });
  if (!(await fleet.start())) throw new Error(`the fleet of ${node} did not start: ${logs.join("; ")}`);
  const daemon = await startDaemon({ service, node, env: env.vars, allowlistPath: env.allowlistPath, now, members: () => fleet.members.view(), remote: fleet.remote });
  const port = (): number => fleet.address()?.port ?? 0;
  return {
    node,
    key,
    env,
    fleetDir,
    fleet,
    daemon,
    service,
    logs,
    port,
    announceTo: (...targets) => writeFileSync(join(fleetDir, "peers.json"), JSON.stringify(targets.map((c) => `${LOOPBACK}:${c.port()}`))),
    async stop() {
      await fleet.stop();
      await daemon.stop();
      env.cleanup();
    },
  };
}

/** A git repository with one commit, under the core's temp tree; returns its real path and HEAD. */
export function gitRepo(core: Core, name: string): { path: string; head: string } {
  const path = join(core.env.root, name);
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]): string => execFileSync(GIT, args, { cwd: path, env: hostEnv(), encoding: "utf8" });
  git("init", "-q", "-b", "main");
  // The message names the repository: two empty commits made in one second would otherwise be one commit.
  git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", `first commit of ${name}`);
  return { path: realpathSync(path), head: git("rev-parse", "HEAD").trim() };
}

/** The executing core thor (alias ALIAS on an allow-listed repository) and the calling core, listed by each other. */
export async function pair(o: { execOptions?: CoreOptions; callerOptions?: CoreOptions } = {}): Promise<{ exec: Core; caller: Core; repo: string }> {
  const execKey = newFleetKey();
  const callerKey = newFleetKey();
  const exec = await startCore("thor", execKey, [[CALLER_NODE, callerKey]], o.execOptions);
  const repo = gitRepo(exec, "repo").path;
  writeFileSync(join(exec.fleetDir, "aliases.json"), JSON.stringify({ version: 1, aliases: [{ alias: ALIAS, repo }] }));
  writeFileSync(exec.env.allowlistPath, JSON.stringify({ version: 1, entries: [{ agent_id: AGENT, harness: "claude-code", repo }] }));
  const caller = await startCore(CALLER_NODE, callerKey, [["thor", execKey]], o.callerOptions);
  caller.announceTo(exec);
  await caller.fleet.announce();
  return { exec, caller, repo };
}

export const submitBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent_id: AGENT,
  harness: "claude-code",
  alias: ALIAS,
  task: "Add a unit test for the parser's empty-input case.",
  caller: { kind: "operator", id: `${CALLER_NODE}-operator` },
  ...extra,
});

/** The events of an SSE body, in order. */
export function sseEvents(text: string): RunEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as RunEvent);
}
