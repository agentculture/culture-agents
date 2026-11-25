/**
 * The harness registry: which harnesses this core can drive, their capability documents, and
 * the driver module plus JSON options the worker loads for a run (`driver.json`). Harness-neutral:
 * nothing exported here carries an AI SDK, OpenShell or vendor type, and importing this module
 * loads no driver (drivers are loaded by path, in the worker process).
 *
 * Harnesses: `claude-code` (AI SDK HarnessAgent + Claude Code adapter, in an OpenShell sandbox),
 * `opencode` (OpenCode v2's own server API, in an OpenShell sandbox), and `stub` (in-process, no
 * sandbox; listed only when `config.stub` is true).
 */
import { fileURLToPath } from "node:url";

import type { Capabilities } from "../contract/index.js";
import { checkSandboxHarness } from "./availability.js";
import { capabilityDocument, type CapabilityInput } from "./common/capabilities.js";
import type { SandboxSettings } from "./common/sandbox-workspace.js";
import { claudeCodeCore, CLAUDE_CODE_TRANSPORT } from "./claude-code/capabilities.js";
import type { HarnessConfig } from "./config.js";
import { openCodeCore, OPENCODE_TRANSPORT } from "./opencode/capabilities.js";
import { stubCore, STUB_TRANSPORT } from "./stub/index.js";

export { HarnessConfigError, loadHarnessConfig } from "./config.js";
export type { HarnessConfig } from "./config.js";
export { UnsupportedCapabilityError, assertSupported, refusalFor } from "./common/capabilities.js";
export type { ControlCapability } from "./common/capabilities.js";
export { guardDriver } from "./common/guard.js";
export type { GuardedDriver } from "./common/guard.js";

export interface HarnessEntry {
  id: string;
  /** The capability document, with availability checked now. */
  capabilities(): Promise<Capabilities>;
  driver: {
    /** Absolute path of the compiled driver module exporting `createDriver`. */
    module: string;
    /** JSON-serializable options for `createDriver` (written to the run directory). */
    options: Record<string, unknown>;
  };
}

const modulePath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function sandboxSettings(config: HarnessConfig, providers: string[]): SandboxSettings {
  return {
    gateway: { ...config.gateway },
    openshellBin: config.openshellBin,
    image: config.image,
    providers: [...providers],
    sandboxPrefix: config.sandboxPrefix,
    ref: config.ref,
    identity: { ...config.identity },
  };
}

async function sandboxDoc(
  config: HarnessConfig,
  providers: string[],
  input: Omit<CapabilityInput, "available" | "version" | "extension">,
  versionOf: (labels: Record<string, string>) => string | null,
): Promise<Capabilities> {
  const check = await checkSandboxHarness(config, providers);
  return capabilityDocument({
    ...input,
    available: check.available,
    version: versionOf(check.labels),
    extension: { image: config.image, providers, ...(check.reasons.length > 0 ? { unavailable: check.reasons } : {}) },
  });
}

export function listHarnesses(config: HarnessConfig): HarnessEntry[] {
  const claudeProviders = [...config.claudeCode.providers];
  const openCodeProviders = [...config.opencode.providers];
  const entries: HarnessEntry[] = [
    {
      id: "claude-code",
      capabilities: () =>
        sandboxDoc(config, claudeProviders, { harness: "claude-code", transport: CLAUDE_CODE_TRANSPORT, core: claudeCodeCore() }, (l) => {
          const cli = l["dev.culture.agents.claude-code"];
          const adapter = l["dev.culture.agents.harness-claude-code"];
          return cli ? `${cli}${adapter ? ` (AI SDK adapter ${adapter})` : ""}` : null;
        }),
      driver: {
        module: modulePath("./claude-code/index.js"),
        options: { sandbox: sandboxSettings(config, claudeProviders), model: config.claudeCode.model },
      },
    },
    {
      id: "opencode",
      capabilities: () =>
        sandboxDoc(config, openCodeProviders, { harness: "opencode", transport: OPENCODE_TRANSPORT, core: openCodeCore() }, (l) =>
          l["dev.culture.agents.opencode"] ?? null,
        ),
      driver: {
        module: modulePath("./opencode/index.js"),
        options: {
          sandbox: sandboxSettings(config, openCodeProviders),
          opencode: {
            model: config.opencode.model,
            baseUrl: config.opencode.baseUrl,
            keyEnv: config.opencode.keyEnv,
            port: config.opencode.port,
          },
        },
      },
    },
  ];
  if (config.stub) {
    entries.push({
      id: "stub",
      capabilities: async () =>
        capabilityDocument({ harness: "stub", available: true, version: "stub-1", transport: STUB_TRANSPORT, core: stubCore() }),
      driver: { module: modulePath("./stub/index.js"), options: { ref: config.ref, identity: { ...config.identity } } },
    });
  }
  return entries;
}

export function getHarness(config: HarnessConfig, id: string): HarnessEntry | undefined {
  return listHarnesses(config).find((entry) => entry.id === id);
}
