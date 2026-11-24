// Fallback probe: drive OpenCode v2 over its own ACP stdio protocol
// (`opencode acp`, JSON-RPC 2.0 over newline-delimited stdin/stdout) inside an
// OpenShell sandbox, through the same sandbox provider's spawn(). No AI SDK.
//
//   node acp-probe.mjs        # prompt "pong", then a long prompt cancelled mid-run
import { createWriteStream } from 'node:fs';
import { connectOpenShell, createOpenShellSandbox } from './openshell-sandbox.mjs';

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${ts()}] ${m}`);
const out = createWriteStream(new URL('./evidence/opencode-v2-acp.ndjson', import.meta.url));

const client = await connectOpenShell();
const provider = createOpenShellSandbox({
  client, image: 'culture-agents-probe:0.3', providers: ['lobes'], log: (m) => log(`[provider] ${m}`),
});
const sandbox = await provider.createSession({ sessionId: `acp-${Date.now()}` });
try {
  const proc = await sandbox.spawn({
    command: 'opencode acp',
    env: { OPENCODE_CONFIG: '/etc/opencode/opencode.json' },
    stdin: true,
  });
  const writer = proc.stdin.getWriter();
  const pending = new Map();
  const updates = [];
  let nextId = 1;
  const send = (msg) => writer.write(new TextEncoder().encode(`${JSON.stringify(msg)}\n`));
  const call = (method, params) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  (async () => {
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log(`non-json: ${line.slice(0, 120)}`); continue; }
        out.write(`${JSON.stringify({ t: ts(), ...msg }).slice(0, 600)}\n`);
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        } else if (msg.method === 'session/update') {
          updates.push(msg.params?.update);
        } else if (msg.method === 'session/request_permission') {
          const allow = msg.params.options.find((o) => o.kind?.startsWith('allow')) ?? msg.params.options[0];
          send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
        }
      }
    }
  })();

  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  log(`initialize ok: agent ${JSON.stringify(init.agentInfo ?? {})} protocol ${init.protocolVersion}`);
  const { sessionId } = await call('session/new', { cwd: sandbox.defaultWorkingDirectory, mcpServers: [] });
  log(`session/new ${sessionId}`);

  const kinds = () => updates.reduce((a, u) => ({ ...a, [u?.sessionUpdate]: (a[u?.sessionUpdate] ?? 0) + 1 }), {});
  const textOf = () => updates.filter((u) => u?.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.content?.text ?? '').join('');

  const r1 = await call('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Reply with exactly the word pong and nothing else. Do not use tools.' }],
  });
  log(`prompt 1 stopReason=${r1.stopReason} updates=${JSON.stringify(kinds())} text=${JSON.stringify(textOf())}`);

  updates.length = 0;
  const p2 = call('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: 'Run the shell command `sleep 120` with your bash tool, then say done.' }],
  });
  const deadline = Date.now() + 90000;
  while (!updates.some((u) => u?.sessionUpdate === 'tool_call') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 3000));
  log('sending session/cancel');
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  const r2 = await p2;
  log(`prompt 2 stopReason=${r2.stopReason} updates=${JSON.stringify(kinds())}`);
  await new Promise((r) => setTimeout(r, 1500));
  const ps = await sandbox.run({ command: 'ps -eo pid,args | grep -E "sleep|opencode" | grep -v grep || true' });
  log(`processes after cancel:\n${ps.stdout.trim()}`);
  await proc.kill();
} finally {
  await sandbox.destroy();
  out.end();
}
