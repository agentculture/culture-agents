// The slice of the OpenShell TypeScript SDK this directory uses, as a
// structural interface so tests can inject a fake gateway. OpenShell types stay
// inside src/sandbox/.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SandboxClient, type SandboxSpec } from "@ai-openshell/sdk";

export type SandboxPolicyInit = NonNullable<SandboxSpec["policy"]>;

export interface CreateSpec {
  name: string;
  image: string;
  providers: string[];
  labels: Record<string, string>;
  policy?: SandboxPolicyInit;
}

export interface SandboxInfo {
  name: string;
  phase: string;
  labels: Record<string, string>;
}

export interface ExecRequest {
  workdir?: string;
  environment?: Record<string, string>;
  stdin?: Buffer;
  noLoginShell?: boolean;
  signal?: AbortSignal;
}

export interface ExecReply {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type StreamEvent =
  | { stream: "stdout" | "stderr"; data: Buffer }
  | { type: "exit"; exitCode: number };

export interface InteractiveControl {
  output: AsyncIterable<StreamEvent>;
  write(data: Buffer): void;
  closeInput(): void;
  cancel(): void;
}

export interface ForwardRef {
  localHost: string;
  localPort: number;
  close(): Promise<void>;
}

export interface OpenShellClientLike {
  create(spec: CreateSpec): Promise<SandboxInfo>;
  get(name: string): Promise<SandboxInfo>;
  listAll(options?: { labelSelector?: string }): Promise<SandboxInfo[]>;
  waitReady(name: string, timeoutSecs: number, options?: { signal?: AbortSignal }): Promise<unknown>;
  delete(name: string, options?: { allowMissing?: boolean }): Promise<unknown>;
  waitDeleted(name: string, timeoutSecs: number): Promise<void>;
  exec(name: string, command: string[], options?: ExecRequest): Promise<ExecReply>;
  execInteractive(
    name: string,
    command: string[],
    options?: ExecRequest & { tty?: boolean },
  ): Promise<InteractiveControl>;
  forward(
    name: string,
    options: { targetPort: number; onConnectionError?: (error: Error) => void },
  ): Promise<ForwardRef>;
}

export interface GatewayOptions {
  /** Default `https://127.0.0.1:17670` (the local gateway). */
  readonly gateway?: string;
  /** Directory holding `ca.crt` and `client/tls.{crt,key}`; default `$OPENSHELL_LOCAL_TLS_DIR`. */
  readonly tlsDir?: string;
}

export const DEFAULT_GATEWAY = "https://127.0.0.1:17670";

/** Connect to an OpenShell gateway over mTLS. Lazy: no RPC is made until first use. */
export async function connectOpenShell(options: GatewayOptions = {}): Promise<OpenShellClientLike> {
  const tlsDir = options.tlsDir ?? process.env["OPENSHELL_LOCAL_TLS_DIR"];
  if (!tlsDir) throw new Error("OpenShell TLS directory not set (OPENSHELL_LOCAL_TLS_DIR)");
  const client = await SandboxClient.connect({
    gateway: options.gateway ?? DEFAULT_GATEWAY,
    caCert: readFileSync(join(tlsDir, "ca.crt")),
    clientCert: readFileSync(join(tlsDir, "client", "tls.crt")),
    clientKey: readFileSync(join(tlsDir, "client", "tls.key")),
  });
  return adaptSandboxClient(client);
}

/** Narrow a real SDK client to the structural interface (and check it at compile time). */
export function adaptSandboxClient(client: SandboxClient): OpenShellClientLike {
  return {
    create: async (spec) => toInfo(await client.create(spec)),
    get: async (name) => toInfo(await client.get(name)),
    listAll: async (options) => (await client.listAll(options ?? null)).map(toInfo),
    waitReady: (name, timeoutSecs, options) => client.waitReady(name, timeoutSecs, options ?? null),
    delete: (name, options) => client.delete(name, options ?? null),
    waitDeleted: (name, timeoutSecs) => client.waitDeleted(name, timeoutSecs),
    exec: (name, command, options) => client.exec(name, command, options ?? null),
    execInteractive: (name, command, options) =>
      client.execInteractive(name, command, options ?? null),
    forward: (name, options) => client.forward(name, options),
  };
}

function toInfo(ref: { name: string; phase: string; labels: Record<string, string> }): SandboxInfo {
  return { name: ref.name, phase: ref.phase, labels: { ...ref.labels } };
}

/** True when an SDK (or fake) error means the sandbox does not exist. */
export function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "not_found";
}

export function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "already_exists";
}

export function isAuthFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "auth" || code === "tls";
}
