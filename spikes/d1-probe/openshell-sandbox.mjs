// Minimal AI SDK sandbox provider on top of NVIDIA OpenShell (spike, plan t1).
//
// Implements HarnessV1SandboxProvider / HarnessV1NetworkSandboxSession with the
// OpenShell TypeScript SDK: exec for run/file I/O, execInteractive (no TTY) for
// spawn with stdin, forward for getPortEndpoint, delete for destroy.
// Throwaway code: no snapshot reuse, no network-policy or request-transformation
// support, no resume beyond rebinding by name.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { SandboxClient } from '@ai-openshell/sdk';
import { extractLines } from '@ai-sdk/provider-utils';

const NOT_FOUND = 44;
const IS_DIR = 45;

export async function connectOpenShell({
  gateway = 'https://127.0.0.1:17670',
  tlsDir = process.env.OPENSHELL_LOCAL_TLS_DIR,
} = {}) {
  if (!tlsDir) throw new Error('OPENSHELL_LOCAL_TLS_DIR is not set');
  return SandboxClient.connect({
    gateway,
    caCert: readFileSync(`${tlsDir}/ca.crt`),
    clientCert: readFileSync(`${tlsDir}/client/tls.crt`),
    clientKey: readFileSync(`${tlsDir}/client/tls.key`),
  });
}

function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// OpenShell caps sandbox names at 19 characters, so a harness session id
// (often longer) maps to a deterministic short hash for create and resume.
function sandboxName(prefix, sessionId) {
  const hash = createHash('sha256').update(String(sessionId)).digest('hex');
  return `${prefix}${hash}`.slice(0, 19);
}

function toReadable(push) {
  let controller;
  const stream = new ReadableStream({ start: (c) => { controller = c; } });
  push.write = (chunk) => { try { controller.enqueue(new Uint8Array(chunk)); } catch {} };
  push.close = () => { try { controller.close(); } catch {} };
  return stream;
}

/** File I/O and processes over OpenShell exec. Shared by the full and restricted views. */
class OpenShellSandboxSession {
  constructor({ client, name, cwd, processes, log }) {
    this.client = client;
    this.name = name;
    this.cwd = cwd;
    this.processes = processes;
    this.log = log;
  }

  get description() {
    return `NVIDIA OpenShell sandbox "${this.name}" rooted at ${this.cwd}. ` +
      'Outbound network is default-deny; only provider-profile hosts are reachable.';
  }

  resolve(path) {
    return posix.isAbsolute(path) ? path : posix.resolve(this.cwd, path);
  }

  async exec(script, { workingDirectory, env, abortSignal, stdin } = {}) {
    abortSignal?.throwIfAborted();
    const res = await this.client.exec(this.name, ['sh', '-c', script], {
      workdir: workingDirectory ? this.resolve(workingDirectory) : this.cwd,
      environment: env,
      stdin,
      noLoginShell: true,
      signal: abortSignal,
    });
    return res;
  }

  async run({ command, workingDirectory, env, abortSignal }) {
    const res = await this.exec(command, { workingDirectory, env, abortSignal });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString('utf8'),
      stderr: res.stderr.toString('utf8'),
    };
  }

  async spawn({ command, workingDirectory, env, abortSignal, stdin }) {
    abortSignal?.throwIfAborted();
    const ctl = await this.client.execInteractive(this.name, ['sh', '-c', command], {
      workdir: workingDirectory ? this.resolve(workingDirectory) : this.cwd,
      environment: env,
      tty: false,
      noLoginShell: true,
    });
    if (!stdin) ctl.closeInput();
    const out = {};
    const err = {};
    const stdoutStream = toReadable(out);
    const stderrStream = toReadable(err);
    let resolveExit;
    const exited = new Promise((res) => { resolveExit = res; });
    (async () => {
      let code;
      try {
        for await (const ev of ctl.output) {
          if (ev.type === 'exit') code = ev.exitCode;
          else if (ev.stream === 'stdout') out.write(ev.data);
          else err.write(ev.data);
        }
      } catch (e) {
        this.log?.(`spawn stream ended: ${e?.message ?? e}`);
      }
      out.close();
      err.close();
      resolveExit({ exitCode: code ?? ctl.exitCode ?? 137 });
    })();
    const handle = {
      stdout: stdoutStream,
      stderr: stderrStream,
      wait: () => exited,
      kill: async () => { ctl.cancel(); },
    };
    if (stdin) {
      handle.stdin = new WritableStream({
        write: (chunk) => ctl.write(Buffer.from(chunk)),
        close: () => ctl.closeInput(),
      });
    }
    this.processes.add(handle);
    exited.then(() => this.processes.delete(handle));
    abortSignal?.addEventListener('abort', () => handle.kill(), { once: true });
    return handle;
  }

  async readBinaryFile({ path, abortSignal }) {
    const p = q(this.resolve(path));
    const res = await this.exec(
      `[ -e ${p} ] || exit ${NOT_FOUND}; [ -d ${p} ] && exit ${IS_DIR}; cat -- ${p}`,
      { abortSignal },
    );
    if (res.exitCode === NOT_FOUND) return null;
    if (res.exitCode !== 0) throw new Error(`read ${path}: exit ${res.exitCode} ${res.stderr}`);
    return new Uint8Array(res.stdout);
  }

  async readFile(opts) {
    const bytes = await this.readBinaryFile(opts);
    if (bytes == null) return null;
    return new ReadableStream({ start: (c) => { c.enqueue(bytes); c.close(); } });
  }

  async readTextFile({ path, encoding = 'utf-8', startLine, endLine, abortSignal }) {
    const bytes = await this.readBinaryFile({ path, abortSignal });
    if (bytes == null) return null;
    return extractLines({ text: Buffer.from(bytes).toString(encoding), startLine, endLine });
  }

  async writeBinaryFile({ path, content, abortSignal }) {
    const full = this.resolve(path);
    const res = await this.exec(`mkdir -p ${q(posix.dirname(full))} && cat > ${q(full)}`, {
      abortSignal,
      stdin: Buffer.from(content),
    });
    if (res.exitCode !== 0) throw new Error(`write ${path}: exit ${res.exitCode} ${res.stderr}`);
  }

  async writeTextFile({ path, content, encoding = 'utf-8', abortSignal }) {
    await this.writeBinaryFile({ path, content: Buffer.from(content, encoding), abortSignal });
  }

  async writeFile({ path, content, abortSignal }) {
    const chunks = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    await this.writeBinaryFile({ path, content: Buffer.concat(chunks), abortSignal });
  }

  async stat({ path, abortSignal }) {
    const p = q(this.resolve(path));
    const res = await this.exec(`[ -e ${p} ] || exit ${NOT_FOUND}; stat -L -c '%F|%s' -- ${p}`, {
      abortSignal,
    });
    if (res.exitCode === NOT_FOUND) return null;
    const [kind, size] = res.stdout.toString().trim().split('|');
    const type = kind.includes('regular') ? 'file' : kind === 'directory' ? 'directory' : 'other';
    return { type, size: Number(size) };
  }

  async listDirectory({ path, abortSignal }) {
    const p = q(this.resolve(path));
    const res = await this.exec(
      `[ -e ${p} ] || exit ${NOT_FOUND}; find ${p} -mindepth 1 -maxdepth 1 -printf '%y %f\\n'`,
      { abortSignal },
    );
    if (res.exitCode === NOT_FOUND) return null;
    const kinds = { f: 'file', d: 'directory', l: 'symlink' };
    return res.stdout.toString().split('\n').filter(Boolean).map((line) => ({
      name: line.slice(2),
      type: kinds[line[0]] ?? 'other',
    }));
  }

  async deleteFile({ path, abortSignal }) {
    const p = q(this.resolve(path));
    const res = await this.exec(`[ -e ${p} ] || [ -L ${p} ] || exit ${NOT_FOUND}; rm -- ${p}`, {
      abortSignal,
    });
    return res.exitCode === 0;
  }
}

class OpenShellNetworkSandboxSession extends OpenShellSandboxSession {
  constructor(opts) {
    super({ ...opts, processes: new Set() });
    this.id = opts.name;
    this.defaultWorkingDirectory = opts.cwd;
    this.ports = [opts.port];
    this.forwards = new Map();
    this.ended = false;
  }

  restricted = () => new OpenShellSandboxSession({
    client: this.client, name: this.name, cwd: this.cwd, processes: this.processes, log: this.log,
  });

  getPortEndpoint = async ({ port, protocol = 'http' }) => {
    let fwd = this.forwards.get(port);
    if (!fwd) {
      fwd = await this.client.forward(this.name, {
        targetPort: port,
        onConnectionError: (e) => this.log?.(`forward ${port}: ${e.message}`),
      });
      this.forwards.set(port, fwd);
      this.log?.(`forward 127.0.0.1:${fwd.localPort} -> ${this.name}:${port}`);
    }
    return { url: `${protocol}://127.0.0.1:${fwd.localPort}` };
  };

  getPortUrl = async (opts) => (await this.getPortEndpoint(opts)).url;

  setPorts = async (ports) => { this.ports = [...ports]; };

  stop = async () => {
    for (const proc of [...this.processes]) await proc.kill();
    for (const fwd of this.forwards.values()) await fwd.close().catch(() => {});
    this.forwards.clear();
  };

  destroy = async () => {
    if (this.ended) return;
    this.ended = true;
    await this.stop();
    await this.client.delete(this.name, { allowMissing: true });
    await this.client.waitDeleted(this.name, 120).catch(() => {});
    this.log?.(`deleted sandbox ${this.name}`);
  };
}

/** @returns {import('@ai-sdk/harness').HarnessV1SandboxProvider} */
export function createOpenShellSandbox({
  client,
  image,
  providers = [],
  port = 4100,
  prefix = 'spike-',
  log,
}) {
  async function bind(name) {
    const probe = await client.exec(name, ['sh', '-c', 'pwd'], { noLoginShell: true });
    const cwd = probe.stdout.toString().trim() || '/sandbox';
    return new OpenShellNetworkSandboxSession({ client, name, cwd, port, log });
  }
  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: 'openshell',
    createSession: async (options = {}) => {
      options.abortSignal?.throwIfAborted();
      const name = sandboxName(prefix, options.sessionId ?? Date.now().toString(36));
      const t0 = Date.now();
      await client.create({ name, image, providers });
      await client.waitReady(name, 180, { signal: options.abortSignal });
      log?.(`sandbox ${name} ready in ${Date.now() - t0} ms (identity ${options.identity})`);
      const session = await bind(name);
      if (options.onFirstCreate) {
        await options.onFirstCreate(session.restricted(), { abortSignal: options.abortSignal });
      }
      return session;
    },
    resumeSession: async ({ sessionId }) => bind(sandboxName(prefix, sessionId)),
  };
}
