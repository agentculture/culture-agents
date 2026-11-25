// AI-SDK-shaped view of a run sandbox, for the harness adapter layer only:
// HarnessV1NetworkSandboxSession over RunSandbox.
// AI SDK types appear in this file and nowhere else in core.
import { posix } from "node:path";

import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";

import { NOT_FOUND_EXIT, shellQuote } from "./run-sandbox.js";
import type { RunProcess, RunSandbox } from "./types.js";

type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession["restricted"]>;
type RunOptions = Parameters<SandboxSession["run"]>[0];
type SpawnOptions = Parameters<SandboxSession["spawn"]>[0];
type ProcessView = Awaited<ReturnType<SandboxSession["spawn"]>>;

export const PROVIDER_ID = "openshell";
/** Port the AI SDK bridges listen on inside the sandbox (the probe used 4100). */
export const DEFAULT_BRIDGE_PORT = 4100;

const decoder = (encoding = "utf-8") => new TextDecoder(encoding);

function sig(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/** The line ending `text` uses: CRLF, else LF, else a lone CR; LF when it has none. */
function eolOf(text: string): string {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\n")) return "\n";
  return text.includes("\r") ? "\r" : "\n";
}

/** `stat -c %F` output as the AI SDK's entry type. */
function entryType(kind: string): "file" | "directory" | "other" {
  if (kind.includes("regular")) return "file";
  return kind === "directory" ? "directory" : "other";
}

/** Same slicing as the AI SDK's extractLines: 1-based, inclusive, clamped. */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine == null && endLine == null) return text;
  const eol = eolOf(text);
  const lines = text.split(eol);
  const start = Math.max(1, startLine ?? 1) - 1;
  const end = Math.min(lines.length, endLine ?? lines.length);
  return lines.slice(start, end).join(eol);
}

function toProcessView(proc: RunProcess, withStdin: boolean): ProcessView {
  const base = {
    stdout: proc.stdout,
    stderr: proc.stderr,
    wait: () => proc.wait(),
    kill: () => proc.cancel(),
  };
  if (!withStdin) return base;
  return {
    ...base,
    stdin: new WritableStream<Uint8Array>({
      write: (chunk) => proc.write(chunk),
      close: () => proc.closeInput(),
      abort: () => proc.closeInput(),
    }),
  };
}

function sandboxSession(sb: RunSandbox): SandboxSession {
  const run = async ({ command, workingDirectory, env, abortSignal, maxOutputLength }: RunOptions) => {
    const res = await sb.exec(command, {
      ...(workingDirectory ? { cwd: workingDirectory } : {}),
      ...(env ? { env } : {}),
      ...sig(abortSignal),
    });
    const stdout = decoder().decode(res.stdout);
    const stderr = decoder().decode(res.stderr);
    if (maxOutputLength == null) return { exitCode: res.exitCode, stdout, stderr };
    return {
      exitCode: res.exitCode,
      stdout: stdout.slice(0, maxOutputLength),
      stderr: stderr.slice(0, maxOutputLength),
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    };
  };
  const spawn = async ({ command, workingDirectory, env, abortSignal, stdin }: SpawnOptions) => {
    const proc = await sb.spawn(command, {
      stdin: stdin === true,
      ...(workingDirectory ? { cwd: workingDirectory } : {}),
      ...(env ? { env } : {}),
      ...sig(abortSignal),
    });
    return toProcessView(proc, stdin === true);
  };
  const readBinaryFile = ({ path, abortSignal }: { path: string; abortSignal?: AbortSignal }) =>
    sb.readFile(path, sig(abortSignal));
  const writeBinaryFile = ({ path, content, abortSignal }: { path: string; content: Uint8Array; abortSignal?: AbortSignal }) =>
    sb.writeFile(path, content, sig(abortSignal));
  const q = (path: string) => shellQuote(posix.resolve(sb.home, path));
  return {
    description:
      `NVIDIA OpenShell sandbox "${sb.name}" for run ${sb.runId}, rooted at ${sb.home}. ` +
      "Outbound network is default-deny; only provider-profile hosts are reachable.",
    run,
    spawn: spawn as SandboxSession["spawn"],
    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      if (bytes == null) return null;
      return new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(bytes);
          c.close();
        },
      });
    },
    readTextFile: async ({ path, encoding, startLine, endLine, abortSignal }) => {
      const bytes = await readBinaryFile({ path, ...(abortSignal ? { abortSignal } : {}) });
      if (bytes == null) return null;
      return sliceLines(decoder(encoding).decode(bytes), startLine, endLine);
    },
    writeBinaryFile,
    writeTextFile: ({ path, content, abortSignal }) =>
      writeBinaryFile({ path, content: new TextEncoder().encode(content), ...(abortSignal ? { abortSignal } : {}) }),
    writeFile: async ({ path, content, abortSignal }) => {
      const bytes = new Uint8Array(await new Response(content).arrayBuffer());
      await writeBinaryFile({ path, content: bytes, ...(abortSignal ? { abortSignal } : {}) });
    },
    stat: async ({ path, abortSignal }) => {
      const p = q(path);
      const res = await sb.exec(`[ -e ${p} ] || exit ${NOT_FOUND_EXIT}; stat -L -c '%F|%s' -- ${p}`, sig(abortSignal));
      if (res.exitCode === NOT_FOUND_EXIT) return null;
      if (res.exitCode !== 0) throw new Error(`stat ${path}: exit ${res.exitCode}`);
      const [kind = "", size = "0"] = decoder().decode(res.stdout).trim().split("|");
      return { type: entryType(kind), size: Number(size) };
    },
    listDirectory: async ({ path, abortSignal }) => {
      const p = q(path);
      const res = await sb.exec(
        String.raw`[ -e ${p} ] || exit ${NOT_FOUND_EXIT}; find ${p} -mindepth 1 -maxdepth 1 -printf '%y %f\n'`,
        sig(abortSignal),
      );
      if (res.exitCode === NOT_FOUND_EXIT) return null;
      if (res.exitCode !== 0) throw new Error(`list ${path}: exit ${res.exitCode}`);
      const kinds: Record<string, "file" | "directory" | "symlink"> = { f: "file", d: "directory", l: "symlink" };
      return decoder()
        .decode(res.stdout)
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ name: line.slice(2), type: kinds[line[0] ?? ""] ?? "other" }));
    },
    deleteFile: async ({ path, abortSignal }) => {
      const p = q(path);
      const res = await sb.exec(`[ -e ${p} ] || [ -L ${p} ] || exit ${NOT_FOUND_EXIT}; rm -- ${p}`, sig(abortSignal));
      return res.exitCode === 0;
    },
  };
}

/** The AI SDK network sandbox session over one run sandbox. */
export function toHarnessSandboxSession(
  sb: RunSandbox,
  options: { ports?: readonly number[] } = {},
): HarnessV1NetworkSandboxSession {
  let ports: readonly number[] = [...(options.ports ?? [DEFAULT_BRIDGE_PORT])];
  const getPortEndpoint = async ({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) => {
    const ep = await sb.endpoint(port);
    return { url: `${protocol}://${ep.host}:${ep.port}` };
  };
  return {
    ...sandboxSession(sb),
    id: sb.name,
    defaultWorkingDirectory: sb.home,
    get ports() {
      return ports;
    },
    getPortEndpoint,
    getPortUrl: async (o) => (await getPortEndpoint(o)).url,
    setPorts: async (next) => {
      ports = [...next];
    },
    stop: () => sb.stop(),
    destroy: () => sb.destroy(),
    restricted: () => sandboxSession(sb),
  };
}
