// Provider self-test without any harness: exec, file I/O, spawn+stdin, forward, delete.
import { connectOpenShell, createOpenShellSandbox } from './openshell-sandbox.mjs';
const log = (m) => console.log(`[provider] ${m}`);
const client = await connectOpenShell();
const provider = createOpenShellSandbox({ client, image: 'culture-agents-probe:0.3', log });
const s = await provider.createSession({ sessionId: 'selftest' });
try {
  console.log('cwd', s.defaultWorkingDirectory, (await s.run({ command: 'id -un; echo $HOME' })).stdout.trim());
  await s.writeTextFile({ path: 'a/b.txt', content: 'hello\nworld\n' });
  console.log('read', JSON.stringify(await s.readTextFile({ path: 'a/b.txt', startLine: 2 })));
  console.log('stat', await s.stat({ path: 'a' }), await s.stat({ path: 'nope' }));
  console.log('ls', await s.listDirectory({ path: 'a' }), 'del', await s.deleteFile({ path: 'a/b.txt' }));
  const p = await s.spawn({ command: 'cat; echo done >&2', stdin: true });
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode('via-stdin\n')); await w.close();
  const txt = await new Response(p.stdout).text();
  console.log('spawn', JSON.stringify(txt), await p.wait());
  const srv = await s.spawn({ command: 'node -e "require(\'http\').createServer((q,r)=>r.end(\'pong\')).listen(4100,\'0.0.0.0\')"' });
  await new Promise((r) => setTimeout(r, 1500));
  const ep = await s.getPortEndpoint({ port: 4100 });
  console.log('forward', ep.url, await (await fetch(ep.url.replace(/^ws/, 'http'))).text());
  await srv.kill();
  await new Promise((r) => setTimeout(r, 1000));
  console.log('after kill', (await s.run({ command: 'pgrep -af "node -e" || echo no-node' })).stdout.trim());
} finally {
  await s.destroy();
}
