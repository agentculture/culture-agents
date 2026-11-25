/**
 * Whether a sandboxed harness can start right now: the gateway's mTLS material is present, the
 * run image exists locally (Docker compute driver), and every credential provider the harness
 * attaches exists on the gateway. Each check is a short host command; none reads a credential.
 * Names are validated when the configuration is loaded and are passed after `--` as well, so a
 * name can never be read as an option (docker and the openshell CLI 0.1.10 both accept `--`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HarnessConfig } from "./config.js";

export interface Availability {
  available: boolean;
  /** Why it is unavailable (empty when available). */
  reasons: string[];
  /** Labels of the run image (versions baked by core/image/build.sh). */
  labels: Record<string, string>;
}

function run(file: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout, stderr: stderr || (error ? error.message : "") });
    });
  });
}

const firstLine = (text: string) => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

export async function checkSandboxHarness(config: HarnessConfig, providers: readonly string[]): Promise<Availability> {
  const reasons: string[] = [];
  let labels: Record<string, string> = {};
  const tls = config.gateway.tlsDir;
  if (!tls) reasons.push("no OpenShell TLS directory is configured (gateway.tlsDir or OPENSHELL_LOCAL_TLS_DIR)");
  else if (!["ca.crt", join("client", "tls.crt"), join("client", "tls.key")].every((f) => existsSync(join(tls, f)))) {
    reasons.push(`the OpenShell TLS directory ${tls} lacks ca.crt or client/tls.{crt,key}`);
  }
  const image = await run(config.dockerBin, ["image", "inspect", "--format", "{{json .Config.Labels}}", "--", config.image]);
  if (image.code !== 0) reasons.push(`run image ${config.image} is not present: ${firstLine(image.stderr)} (build it with core/image/build.sh)`);
  else {
    try {
      labels = (JSON.parse(image.stdout) as Record<string, string> | null) ?? {};
    } catch {
      labels = {};
    }
  }
  const gw = config.gateway.name ? ["-g", config.gateway.name] : [];
  const checks = await Promise.all(providers.map((p) => run(config.openshellBin, [...gw, "provider", "get", "--", p])));
  checks.forEach((res, i) => {
    if (res.code !== 0) reasons.push(`provider ${providers[i] as string} is not available on the gateway: ${firstLine(res.stderr || res.stdout)}`);
  });
  return { available: reasons.length === 0, reasons, labels };
}
