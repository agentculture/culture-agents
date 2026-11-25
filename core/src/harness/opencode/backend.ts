/**
 * OpenCode v2 driven through its own server API. In the run's sandbox the backend writes an
 * OpenCode config for the model gateway, starts `opencode serve` in the cloned repository with a
 * per-run password, reaches it through the sandbox's port forward, and creates one session at
 * the clone with the configured model. Closing the backend ends the server process.
 */
import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import type { RunProcess, RunSandbox } from "../../sandbox/index.js";
import { errorMessage, within } from "../common/queue.js";
import { tapWriter } from "../common/text.js";
import type { HarnessBackend, HarnessSession, Sink, Workspace } from "../common/types.js";
import { OpenCodeClient, type FetchLike } from "./client.js";
import { startOpenCodeTurn, type TurnTiming } from "./turn.js";

/** JSON-serializable OpenCode settings (part of the driver options). */
export interface OpenCodeSettings {
  /** `<provider id>/<model id>`. */
  model: string;
  /** OpenAI-compatible base URL of the model gateway as the sandbox sees it. */
  baseUrl: string;
  /** Sandbox variable holding OpenShell's placeholder for the gateway key. */
  keyEnv: string;
  port: number;
  /** Absolute path of the OpenCode binary in the image (the path the gateway profile allows). */
  binary?: string;
  startTimeoutMs?: number;
  /** Live-test recording: a file that receives every raw server event. */
  tap?: string;
}

/** A workspace that exposes its sandbox (the real one, or a test double). */
export interface SandboxBacked extends Workspace {
  readonly sandbox: Pick<RunSandbox, "home" | "spawn" | "writeFile" | "endpoint">;
}

export const CONFIG_PATH = ".culture-agents/opencode.json";

/** The OpenCode config for the model gateway. The key is a `{env:...}` reference, never a value. */
export function openCodeConfig(settings: OpenCodeSettings): Record<string, unknown> {
  const [providerId, ...rest] = settings.model.split("/");
  const modelId = rest.join("/");
  return {
    provider: {
      [providerId as string]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local model gateway",
        options: { baseURL: settings.baseUrl, apiKey: `{env:${settings.keyEnv}}` },
        models: { [modelId]: { name: modelId, tool_call: true, reasoning: true } },
      },
    },
    model: settings.model,
    small_model: settings.model,
    autoupdate: false,
    share: "disabled",
  };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Read `stream` until `pattern` matches a line; keep draining afterwards into `tail`. */
async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, tail: string[]): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let found = false;
  let notify!: (v: boolean) => void;
  const result = new Promise<boolean>((resolve) => (notify = resolve));
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          tail.push(line);
          if (tail.length > 40) tail.shift();
          if (!found && pattern.test(line)) {
            found = true;
            notify(true);
          }
        }
      }
    } catch {
      // the process ended or was cancelled
    }
    notify(found);
  })();
  return result;
}

function drain(stream: ReadableStream<Uint8Array>, tail: string[]): void {
  void waitForLine(stream, /$^/, tail);
}

export class OpenCodeBackend<W extends SandboxBacked> implements HarnessBackend<W> {
  constructor(
    private readonly settings: OpenCodeSettings,
    private readonly fetchImpl?: FetchLike,
    private readonly timing: TurnTiming = {},
  ) {}

  async open(workspace: W, signal: AbortSignal, sink: Sink): Promise<HarnessSession> {
    const sb = workspace.sandbox;
    const s = this.settings;
    const configPath = posix.join(sb.home, CONFIG_PATH);
    await sb.writeFile(configPath, new TextEncoder().encode(JSON.stringify(openCodeConfig(s), null, 2)), { signal });
    const password = randomBytes(24).toString("base64url");
    const binary = s.binary ?? "/usr/local/bin/opencode";
    const proc: RunProcess = await sb.spawn(`exec ${shq(binary)} serve --hostname 127.0.0.1 --port ${s.port}`, {
      cwd: workspace.workdir,
      env: { OPENCODE_CONFIG: configPath, OPENCODE_SERVER_PASSWORD: password },
    });
    const closer = new AbortController();
    let closed: Promise<void> | null = null;
    const close = () =>
      (closed ??= (async () => {
        closer.abort();
        await proc.cancel().catch(() => undefined);
      })());
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      drain(proc.stderr, stderr);
      const ready = await within(s.startTimeoutMs ?? 30_000, waitForLine(proc.stdout, /server listening on /, stdout));
      if (!ready) throw new Error(`opencode serve did not report listening: ${[...stdout, ...stderr].slice(-5).join(" | ").slice(0, 800)}`);
      const ep = await sb.endpoint(s.port);
      const client = new OpenCodeClient(`http://${ep.host}:${ep.port}`, password, this.fetchImpl);
      const [providerID, ...rest] = s.model.split("/");
      const session = await client.createSession({ directory: workspace.workdir, providerID: providerID as string, modelID: rest.join("/") });
      void proc.wait().then(({ exitCode }) => {
        if (!closer.signal.aborted) sink({ type: "error", error: { code: "internal", message: `opencode serve exited (${exitCode}): ${stderr.slice(-3).join(" | ").slice(0, 500)}`, retryable: false } });
      });
      return {
        startTurn: (task) => {
          const tap = tapWriter(s.tap);
          return startOpenCodeTurn(client, session.id, task, closer.signal, sink, tap ? { ...this.timing, tap } : this.timing);
        },
        close,
      };
    } catch (err) {
      await close();
      throw new Error(`could not start OpenCode: ${errorMessage(err)}`);
    }
  }
}
