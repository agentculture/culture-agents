// Live test against a real OpenShell gateway. With no reachable gateway (CI,
// a laptop without OpenShell) every check is reported NOT VERIFIED as a skip,
// never as a pass. Needs: OPENSHELL_LOCAL_TLS_DIR, a gateway (default
// https://127.0.0.1:17670, or OPENSHELL_GATEWAY_URL), the `openshell` CLI
// (or OPENSHELL_BIN) for ssh-config, an image with git (CULTURE_AGENTS_SANDBOX_IMAGE,
// default culture-agents-probe:0.3). Uses a temporary host repo, never a real
// checkout. No harness or model call is made.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { hostEnv, runCommand } from "../../src/sandbox/host-command.js";
import { connectOpenShell, isNotFound, type OpenShellClientLike } from "../../src/sandbox/openshell-client.js";
import { createRunSandboxes } from "../../src/sandbox/run-sandboxes.js";
import { collect, prepare } from "../../src/sandbox/worktree.js";

const IMAGE = process.env["CULTURE_AGENTS_SANDBOX_IMAGE"] ?? "culture-agents-probe:0.3";
const PREFIX = process.env["CULTURE_AGENTS_SANDBOX_PREFIX"] ?? "catest-";
const OPENSHELL = process.env["OPENSHELL_BIN"] ?? "openshell";
const GATEWAY = process.env["OPENSHELL_GATEWAY_URL"];

async function reachableGateway(): Promise<{ client: OpenShellClientLike } | { reason: string }> {
  const tls = process.env["OPENSHELL_LOCAL_TLS_DIR"];
  if (!tls || !existsSync(join(tls, "ca.crt"))) return { reason: "OPENSHELL_LOCAL_TLS_DIR not set or empty" };
  try {
    const client = await connectOpenShell({ tlsDir: tls, ...(GATEWAY ? { gateway: GATEWAY } : {}) });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000).unref());
    await Promise.race([client.listAll(), timeout]);
    const cli = await runCommand(OPENSHELL, ["--version"]);
    if (cli.code !== 0) return { reason: `openshell CLI not runnable (${OPENSHELL})` };
    return { client };
  } catch (error) {
    return { reason: `gateway unreachable: ${(error as Error).message}` };
  }
}

function notVerified(t: TestContext, reason: string): void {
  const line = `NOT VERIFIED: ${reason}`;
  console.log(line);
  t.skip(line);
}

function hostRepo(dir: string) {
  const host = join(dir, "host");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: host, encoding: "utf8", env: hostEnv() }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", host], { env: hostEnv() });
  writeFileSync(join(host, "README"), "host\n");
  g("add", "README");
  g("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "one");
  g("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "two");
  writeFileSync(join(host, "local-edit.txt"), "uncommitted operator work\n");
  return { host, g };
}

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8").trim();

test("live: run sandbox lifecycle, credential absence, push denial, bundle-in/fetch-out", { timeout: 600_000 }, async (t) => {
  const gw = await reachableGateway();
  if ("reason" in gw) return notVerified(t, gw.reason);
  const { client } = gw;
  const runId = `live-${Date.now().toString(36)}`;
  const sandboxes = createRunSandboxes({ image: IMAGE, prefix: PREFIX, log: (m) => console.log(`[sandbox] ${m}`) }, { client });
  const dir = mkdtempSync(join(tmpdir(), "ca-live-"));
  // Dummy operator credentials in the test process: they must not reach the sandbox.
  const saved = { GH_TOKEN: process.env["GH_TOKEN"], GITHUB_TOKEN: process.env["GITHUB_TOKEN"], SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] };
  process.env["GH_TOKEN"] ??= "dummy-not-a-token";
  process.env["GITHUB_TOKEN"] ??= "dummy-not-a-token";
  process.env["SSH_AUTH_SOCK"] ??= "/nonexistent/agent.sock";
  let name = "";
  try {
    const { host, g } = hostRepo(dir);
    const before = { head: g("symbolic-ref", "HEAD"), main: g("rev-parse", "main"), status: g("status", "--porcelain") };

    await sandboxes.withRun(runId, async (sb) => {
      name = sb.name;
      // 1. Visible on the gateway while the run is live.
      const listed = await client.listAll({ labelSelector: "managed-by=culture-agents" });
      const mine = listed.find((s) => s.name === sb.name);
      assert.ok(mine, `sandbox ${sb.name} listed on the gateway`);
      assert.equal(mine.phase, "ready");
      assert.equal(mine.labels["run-id"], runId);
      console.log(`[live] visible on gateway: ${sb.name} phase=${mine.phase} run-id=${mine.labels["run-id"]}`);

      // The create-time run policy reached the gateway.
      const pol = await runCommand(OPENSHELL, ["policy", "get", sb.name, "--base"]);
      assert.equal(pol.code, 0, pol.stderr);
      assert.match(pol.stdout, /compatibility: hard_requirement/);
      assert.doesNotMatch(pol.stdout, /github/i);

      // 2. No operator credentials inside (names only, never values).
      const env = await sb.exec("env | cut -d= -f1 | grep -x -E 'GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK' || true");
      assert.equal(text(env.stdout), "", "GH_TOKEN, GITHUB_TOKEN and SSH_AUTH_SOCK are unset");
      console.log("[live] GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK unset inside");

      // 3. Bundle in.
      const tree = await prepare(sb, {
        hostRepo: host,
        ref: "main",
        runId,
        identity: { name: `run ${runId}`, email: "run@runs.invalid" },
      });
      assert.equal(tree.baseCommit, before.main);

      // 4. A push to a GitHub remote fails at the network, not at auth.
      const push = await sb.exec(
        "cd work && timeout 60 git push https://github.com/agentculture/culture-agents.git HEAD:refs/heads/sandbox-push-probe",
        { env: { GIT_TERMINAL_PROMPT: "0" } },
      );
      const pushErr = text(push.stderr);
      console.log(`[live] https push exit=${push.exitCode}: ${pushErr.split("\n")[0]}`);
      assert.notEqual(push.exitCode, 0);
      assert.match(pushErr, /connect|resolve|proxy|denied|403|timed out/i);
      assert.doesNotMatch(pushErr, /Username|Authentication failed|Permission to/);
      const sshPush = await sb.exec(
        "cd work && command -v ssh >/dev/null || { echo no-ssh-client >&2; exit 97; }; " +
          "GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=20' timeout 60 git push git@github.com:agentculture/culture-agents.git HEAD:refs/heads/sandbox-push-probe",
      );
      console.log(`[live] ssh push exit=${sshPush.exitCode}: ${text(sshPush.stderr).split("\n")[0]}`);
      assert.notEqual(sshPush.exitCode, 0);

      // 5. A commit made inside comes back on runs/<id>; host branch and status unchanged.
      const commit = await sb.exec(
        "cd work && echo from-sandbox > run.txt && git add run.txt && git commit -q -m 'run commit' && git rev-parse HEAD",
      );
      assert.equal(commit.exitCode, 0, text(commit.stderr));
      const inside = text(commit.stdout);
      const out = await collect(sb, { hostRepo: host, runId, remotePath: tree.path, openshellBin: OPENSHELL });
      assert.equal(out.commit, inside);
      assert.equal(g("rev-parse", `runs/${runId}`), inside);
      assert.equal(g("rev-parse", `runs/${runId}~1`), before.main);
      assert.deepEqual({ head: g("symbolic-ref", "HEAD"), main: g("rev-parse", "main"), status: g("status", "--porcelain") }, before);
      assert.equal(existsSync(join(host, "run.txt")), false, "host working tree not written");
      console.log(`[live] fetched runs/${runId} = ${inside.slice(0, 12)}; host HEAD/main/status unchanged`);
    });

    // 6. Gone from the gateway once the run ended.
    await assert.rejects(client.get(name), (error: unknown) => isNotFound(error));
    const after = await client.listAll({ labelSelector: "managed-by=culture-agents" });
    assert.equal(after.some((s) => s.name === name), false);
    console.log(`[live] ${name} deleted after the run`);
  } finally {
    if (saved.GH_TOKEN === undefined) delete process.env["GH_TOKEN"];
    if (saved.GITHUB_TOKEN === undefined) delete process.env["GITHUB_TOKEN"];
    if (saved.SSH_AUTH_SOCK === undefined) delete process.env["SSH_AUTH_SOCK"];
    await sandboxes.destroy(runId).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
