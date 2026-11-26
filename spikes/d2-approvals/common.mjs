// Shared plumbing for the D2 approvals probes. Throwaway probe code: never built or linted.
//
// Both probes run the harness the way the core runs it in production: one OpenShell run
// sandbox per probe, created through the BUILT core (core/dist), with the repository handed in
// as a git bundle. Build the core first: (cd core && npm ci && npm run build).
//
// Environment (set for the command only, never in a sourced file):
//   OPENSHELL_LOCAL_TLS_DIR   the gateway's client TLS directory (required)
//   PATH                      must contain the `openshell` binary (or CULTURE_AGENTS_OPENSHELL_BIN)
//   PROBE_HOLD_MS             how long the pending question is held before the answer (default 20000)
//   plus the core's own harness configuration (core/src/harness/config.ts).
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = new URL('../../core/', import.meta.url);
export const coreImport = (rel) => import(new URL(rel, CORE).href);

export const HOLD_MS = Number(process.env.PROBE_HOLD_MS ?? '20000');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const text = (bytes) => Buffer.from(bytes).toString('utf8');

/** A log on stdout and an NDJSON record under evidence/, both with seconds since start. */
export function evidence(name) {
  mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
  const out = createWriteStream(new URL(`./evidence/${name}.ndjson`, import.meta.url));
  const t0 = Date.now();
  const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  return {
    log: (m) => console.log(`[${ts()}] ${m}`),
    record: (obj) => out.write(`${JSON.stringify({ t: ts(), ...obj })}\n`),
    close: () => new Promise((r) => out.end(r)),
  };
}

/** A temporary host repository with one commit (the run starts from it). */
export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'd2-approvals-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README'), 'probe repository\n');
  git('add', '-A');
  git('-c', 'user.name=probe', '-c', 'user.email=probe@culture-agents.invalid', 'commit', '-q', '-m', 'init');
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Open a run sandbox exactly as a driver does (SandboxWorkspaceFactory), with the given
 * credential providers. Sandboxes are named `<prefix><run id>`; the prefix defaults to `t1q-`
 * so they cannot be mistaken for a running core's sandboxes.
 */
export async function openWorkspace(runId, providersOf, log) {
  const { loadHarnessConfig } = await coreImport('dist/src/harness/config.js');
  const { SandboxWorkspaceFactory } = await coreImport('dist/src/harness/common/sandbox-workspace.js');
  const config = loadHarnessConfig({ CULTURE_AGENTS_SANDBOX_PREFIX: 't1q-', ...process.env });
  const repo = tempRepo();
  const settings = {
    gateway: config.gateway,
    openshellBin: config.openshellBin,
    image: config.image,
    providers: providersOf(config),
    sandboxPrefix: config.sandboxPrefix,
    ref: 'HEAD',
    identity: config.identity,
    retainFailedSandboxDays: 0,
  };
  log(`creating sandbox for run ${runId} (image ${config.image}, providers ${settings.providers.join(',')})`);
  const workspace = await new SandboxWorkspaceFactory(runId, repo.dir, settings).open(new AbortController().signal);
  log(`sandbox ${workspace.sandbox.name} ready, working tree ${workspace.workdir}`);
  return {
    config,
    workspace,
    /** Run a shell script in the sandbox's working tree and return trimmed stdout. */
    sh: async (script) => text((await workspace.sandbox.exec(script, { cwd: workspace.workdir })).stdout).trim(),
    cleanup: async () => {
      await workspace.destroy().catch((e) => log(`sandbox delete failed: ${e?.message ?? e}`));
      repo.remove();
      log(`sandbox ${workspace.sandbox.name} deleted`);
    },
  };
}

export const runId = (label) => `${label}-${Date.now().toString(36)}`;
