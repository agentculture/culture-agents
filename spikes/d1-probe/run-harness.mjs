// Drive a harness adapter through HarnessAgent on an OpenShell sandbox.
//
//   node run-harness.mjs <claude|opencode> <smoke|steer|cancel>
//
// smoke  - one short prompt, stream events, destroy.
// steer  - ten numbered files one at a time; after the 2nd write, steer with
//          experimental_steerTurn (HarnessV1PromptControl.submitUserMessage).
// cancel - long task; abort the turn after the first tool call, show the
//          in-sandbox processes are gone, then destroy and confirm deletion.
// Transcript (NDJSON of stream parts) goes to evidence/<harness>$SPIKE_TAG-<mode>.ndjson.
// SPIKE_IMAGE picks the sandbox image (default culture-agents-probe:0.3).
import { createWriteStream } from 'node:fs';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createOpenCode } from '@ai-sdk/harness-opencode';
import { connectOpenShell, createOpenShellSandbox } from './openshell-sandbox.mjs';

const [harnessName = 'claude', mode = 'smoke'] = process.argv.slice(2);
const IMAGE = process.env.SPIKE_IMAGE ?? 'culture-agents-probe:0.3';
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (m) => console.log(`[${ts()}] ${m}`);
const out = createWriteStream(new URL(`./evidence/${harnessName}${process.env.SPIKE_TAG ?? ""}-${mode}.ndjson`, import.meta.url));
const record = (obj) => out.write(`${JSON.stringify({ t: ts(), ...obj })}\n`);

// OpenCode substitutes {env:NAME} at config load; inside the sandbox that env
// var holds the OpenShell placeholder, never the real gateway key.
const gatewayKeyRef = '{env:LOBES_GATEWAY_KEY}';

const HARNESSES = {
  claude: {
    providers: ['claude-sub'],
    model: 'haiku',
    // Empty auth env: the host forwards no credential. The bridge process
    // inherits the sandbox env, where OpenShell put a placeholder for
    // CLAUDE_CODE_OAUTH_TOKEN that its proxy resolves at egress.
    harness: () => createClaudeCode({ auth: {} }),
  },
  opencode: {
    providers: ['lobes'],
    model: 'gateway/worker',
    harness: () => createOpenCode({
      auth: {},
      openCodeConfig: {
        provider: {
          gateway: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Local model gateway',
            options: {
              baseURL: 'http://host.openshell.internal:8001/v1',
              apiKey: gatewayKeyRef,
            },
            models: { worker: { name: 'worker', tool_call: true } },
          },
        },
      },
    }),
  },
};

const PROMPTS = {
  smoke: 'Reply with exactly the word pong and nothing else. Do not use any tools.',
  steer: 'Create ten files named file01.txt to file10.txt in the current directory, ' +
    'ONE AT A TIME with a separate Write tool call each (never in parallel, never via Bash). ' +
    'Each file contains just its number. Do not explain.',
  cancel: 'Run the shell command `sleep 120` with the Bash tool, then write done.txt.',
};
const STEER_TEXT = 'Change of plan: stop after file03.txt. Do not create file04.txt or later. ' +
  'Instead create a file named STEERED.txt containing the word steered, then finish.';

const spec = HARNESSES[harnessName];
if (!spec || !PROMPTS[mode]) throw new Error('usage: run-harness.mjs <claude|opencode> <smoke|steer|cancel>');

const client = await connectOpenShell();
const base = createOpenShellSandbox({
  client, image: IMAGE, providers: spec.providers, log: (m) => log(`[provider] ${m}`),
});
let sandbox;
const provider = { ...base, createSession: async (o) => (sandbox = await base.createSession(o)) };

const agent = new HarnessAgent({
  harness: spec.harness(),
  model: spec.model,
  sandbox: provider,
  permissionMode: 'allow-all',
  onLog: (d) => record({ diag: d.level, msg: String(d.message).slice(0, 300) }),
});

const sessionId = `${harnessName}-${mode}-${Date.now().toString(36)}`;
log(`createSession ${sessionId} on ${IMAGE}`);
let session;
try {
  session = await agent.createSession({ sessionId });
} catch (e) {
  // HarnessAgent does not destroy a provider-owned sandbox when doStart fails.
  log(`createSession failed: ${String(e?.message ?? e).slice(0, 2000)}`);
  await sandbox?.destroy();
  process.exit(1);
}
log(`session ready (sandbox ${sandbox?.id})`);

const workDir = async () =>
  (await sandbox.run({ command: `ls -d ${sandbox.defaultWorkingDirectory}/*-${sessionId}*` })).stdout.trim();
const ps = async () =>
  (await sandbox.run({ command: 'ps -eo pid,args | grep -E "claude|opencode|bridge|sleep" | grep -v grep || true' }))
    .stdout.trim();

const abort = new AbortController();
let writes = 0;
let steered = false;
let aborted = false;
const counts = {};
let text = '';
let failure;
try {
  const result = await agent.stream({ session, prompt: PROMPTS[mode], abortSignal: abort.signal });
  for await (const part of result.fullStream) {
    counts[part.type] = (counts[part.type] ?? 0) + 1;
    if (part.type === 'text-delta') text += part.text ?? part.delta ?? '';
    const brief = { type: part.type };
    if (part.type === 'tool-call') {
      brief.tool = part.toolName;
      brief.input = JSON.stringify(part.input).slice(0, 160);
      log(`tool-call ${part.toolName} ${brief.input}`);
    }
    if (part.type === 'error') brief.error = String(part.error?.message ?? part.error).slice(0, 300);
    if (part.type === 'finish') brief.finishReason = part.finishReason;
    record(brief);
    if (mode === 'steer' && part.type === 'tool-result' && /write/i.test(part.toolName ?? '')) {
      writes += 1;
      if (writes === 2 && !steered) {
        steered = true;
        log(`steering after ${writes} writes`);
        await session.experimental_steerTurn(STEER_TEXT);
        record({ steer: STEER_TEXT });
        log('steer accepted by adapter');
      }
    }
    if (mode === 'cancel' && part.type === 'tool-call' && !aborted) {
      aborted = true;
      setTimeout(() => { log('aborting turn'); abort.abort(new Error('spike cancel')); }, 3000);
    }
  }
} catch (e) {
  failure = e;
  log(`stream ended with ${e?.name}: ${String(e?.message ?? e).slice(0, 300)}`);
  record({ thrown: e?.name, msg: String(e?.message ?? e).slice(0, 300) });
}
log(`part counts ${JSON.stringify(counts)}`);
log(`text: ${JSON.stringify(text.slice(0, 200))}`);

try {
  if (mode === 'steer') {
    const dir = await workDir();
    const ls = (await sandbox.run({ command: `ls -1 ${dir}` })).stdout.trim().split('\n');
    log(`files in ${dir}: ${ls.join(' ')}`);
    record({ files: ls });
  }
  if (mode === 'cancel') {
    await new Promise((r) => setTimeout(r, 2000));
    const procs = await ps();
    log(`processes after abort:\n${procs || '(none)'}`);
    record({ processesAfterAbort: procs });
  }
} catch (e) {
  log(`post-run inspection failed: ${e.message}`);
}

await session.destroy();
let gone = false;
try { await client.get(sandbox.id); } catch { gone = true; }
log(`session destroyed; sandbox ${sandbox.id} ${gone ? 'deleted' : 'STILL PRESENT'}`);
record({ destroyed: true, sandboxDeleted: gone });
out.end();
process.exit(failure && mode !== 'cancel' ? 1 : 0);
