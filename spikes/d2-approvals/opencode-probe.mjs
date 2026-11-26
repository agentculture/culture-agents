// Can OpenCode v2, driven through its own server API, ask its operator and wait?
//
//   node opencode-probe.mjs <approve|deny|question>
//
// approve   the session is created with the permission rule {action:*, resource:*, effect:ask}
//           instead of the driver's allow rule. The task needs a file write; the server must
//           raise `permission.asked`, the turn must hold with nothing written, and one reply
//           (`once`) must let the SAME turn write the file.
// deny      same, but the reply is `reject` with a message; the file must not exist.
// question  allow-all permissions (as the driver runs today); the model is told to ask the
//           operator a question. The server must raise `form.created`, hold, and take one
//           answer through the form reply route.
//
// Server routes used (OpenCode 2.3.2, from its own /openapi.json):
//   POST /api/session                       { location, model, permissions: [{action, resource, effect}] }
//   POST /api/session/{id}/prompt           { text }
//   GET  /api/event                         permission.asked / permission.replied / form.created / form.replied
//   GET  /api/session/{id}/permission       pending permission requests
//   POST /api/session/{id}/permission/{requestID}/reply   { decision: once|always|reject, message? }
//   GET  /api/session/{id}/form             pending forms
//   POST /api/session/{id}/form/{formID}/reply            { answer: { <field key>: value } }
// The model is local and slow: nothing here times out a model call. The probe waits for the
// turn for as long as it takes.
// Evidence: evidence/opencode-<mode>[$PROBE_TAG].ndjson and the stdout log.
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

import { evidence, HOLD_MS, coreImport, openWorkspace, runId, sleep, text } from './common.mjs';

const [mode = 'approve'] = process.argv.slice(2);
const TASKS = {
  approve: 'Create a file named approved.txt containing the single word yes. Then reply with the single word done.',
  deny: 'Create a file named approved.txt containing the single word yes. If you are not allowed to, do not try any other way: reply with the exact reason you were given.',
  question:
    'Before doing anything else, ask the operator which colour to use: use your question tool once with the question ' +
    '"Which colour should I use?" and the options red and green. Then create a file named colour.txt containing only the ' +
    "operator's answer, and reply with the single word done.",
};
if (!TASKS[mode]) throw new Error('usage: opencode-probe.mjs <approve|deny|question>');
const DENY_MESSAGE = 'The operator said no: probe-denial-7341.';
const ANSWER = 'ultraviolet-7341';
const PERMISSIONS = {
  approve: [{ action: '*', resource: '*', effect: 'ask' }],
  deny: [{ action: '*', resource: '*', effect: 'ask' }],
  question: [{ action: '*', resource: '*', effect: 'allow' }],
};

const { openCodeConfig, CONFIG_PATH } = await coreImport('dist/src/harness/opencode/backend.js');
const { parseSse } = await coreImport('dist/src/harness/opencode/client.js');

const ev = evidence(`opencode-${mode}${process.env.PROBE_TAG ?? ''}`);
const { log, record } = ev;
const id = runId(`oc${mode[0]}`);
const ws = await openWorkspace(id, (c) => c.opencode.providers, log);
let verdict = 'FAIL';
let proc;
const closer = new AbortController();
try {
  // Start `opencode serve` in the sandbox exactly as core/src/harness/opencode/backend.ts does.
  const sb = ws.workspace.sandbox;
  const oc = ws.config.opencode;
  const configPath = posix.join(sb.home, CONFIG_PATH);
  await sb.writeFile(configPath, new TextEncoder().encode(JSON.stringify(openCodeConfig(oc), null, 2)));
  const password = randomBytes(24).toString('base64url');
  proc = await sb.spawn(`exec /usr/local/bin/opencode serve --hostname 127.0.0.1 --port ${oc.port}`, {
    cwd: ws.workspace.workdir,
    env: { OPENCODE_CONFIG: configPath, OPENCODE_SERVER_PASSWORD: password },
  });
  const serverLines = [];
  const listening = new Promise((resolve, reject) => {
    const pump = async (stream) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        const s = dec.decode(chunk, { stream: true });
        serverLines.push(s);
        if (/server listening on /.test(s)) resolve();
      }
    };
    pump(proc.stdout).catch(reject);
    pump(proc.stderr).catch(() => undefined);
    proc.wait().then(({ exitCode }) => reject(new Error(`opencode serve exited (${exitCode}): ${serverLines.join('').slice(-500)}`)));
  });
  await listening;
  const ep = await sb.endpoint(oc.port);
  const base = `http://${ep.host}:${ep.port}`;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  log(`opencode serve is listening in the sandbox; model ${oc.model}`);

  /** One JSON call to the server. No timeout: a slow local model is never cut off. */
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    record({ call: `${method} ${path}`, status: res.status, body: body ?? null, response: raw.slice(0, 1200) });
    if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${raw.slice(0, 500)}`);
    return json;
  };

  const version = await api('GET', '/api/health').catch(() => null);
  if (version) log(`server health: ${JSON.stringify(version).slice(0, 200)}`);
  const [providerID, ...rest] = oc.model.split('/');
  const session = (await api('POST', '/api/session', {
    location: { directory: ws.workspace.workdir },
    model: { providerID, id: rest.join('/') },
    permissions: PERMISSIONS[mode],
  })).data;
  log(`session ${session.id} created with permissions ${JSON.stringify(PERMISSIONS[mode])}`);
  const sid = encodeURIComponent(session.id);

  // The event stream: collect what the server asks, and what ended the execution.
  const asks = []; // { kind: 'permission' | 'form', data }
  let wake = () => {};
  const signal = () => new Promise((r) => (wake = r));
  let ended = null;
  let finalText = '';
  const tools = new Set();
  let connected;
  const isConnected = new Promise((r) => (connected = r));
  (async () => {
    const res = await fetch(`${base}/api/event`, { headers: { authorization: auth, accept: 'text/event-stream' }, signal: closer.signal });
    for await (const event of parseSse(res.body, closer.signal)) {
      connected();
      const d = event.data ?? {};
      const mine = d.sessionID === session.id || d.form?.sessionID === session.id;
      if (!mine) continue;
      const quiet = /\.delta$|usage|step\.(streamed|first-token)|message\.content/.test(event.type);
      if (!quiet) record({ event: event.type, data: JSON.stringify(d).slice(0, 1500) });
      if (event.type === 'session.tool.input.started') tools.add(String(d.name));
      if (event.type === 'session.tool.called') log(`tool called: ${JSON.stringify(d.input ?? {}).slice(0, 200)}`);
      if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') log(`${event.type}: ${JSON.stringify(d.content ?? d.error ?? null).slice(0, 240)}`);
      if (event.type === 'session.text.ended') finalText = String(d.text ?? finalText);
      if (event.type === 'permission.asked') asks.push({ kind: 'permission', data: d });
      if (event.type === 'form.created') asks.push({ kind: 'form', data: d.form });
      if (event.type === 'permission.replied' || event.type === 'form.replied' || event.type === 'form.cancelled') log(`${event.type}: ${JSON.stringify(d).slice(0, 300)}`);
      if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) {
        ended = event.type;
        if (event.type !== 'session.execution.succeeded') log(`${event.type}: ${JSON.stringify(d).slice(0, 400)}`);
      }
      wake();
    }
  })().catch((e) => {
    if (!closer.signal.aborted) log(`event stream ended: ${e?.message ?? e}`);
    wake();
  });
  await isConnected;

  const state = async (label) => {
    const files = await ws.sh('ls -1 | tr "\\n" " "');
    const active = Object.keys((await api('GET', '/api/session/active')).data).includes(session.id);
    const pendingPermissions = (await api('GET', `/api/session/${sid}/permission`)).data ?? [];
    const pendingForms = (await api('GET', `/api/session/${sid}/form`)).data ?? [];
    log(`${label}: files [${files.trim()}], session active ${active}, pending permissions ${pendingPermissions.length}, pending forms ${pendingForms.length}`);
    record({ state: label, files: files.trim(), active, pendingPermissions: pendingPermissions.length, pendingForms: pendingForms.length });
    return { files, active, pending: pendingPermissions.length + pendingForms.length };
  };

  const formAnswer = (form) => {
    const fields = Array.isArray(form.fields) ? form.fields : Object.values(form.fields ?? {});
    return Object.fromEntries(
      fields.map((f) => {
        if (f.type === 'boolean') return [f.key, true];
        if (f.type === 'integer' || f.type === 'number') return [f.key, 7341];
        if (f.type === 'multiselect') return [f.key, [ANSWER]];
        return [f.key, ANSWER];
      }),
    );
  };

  await api('POST', `/api/session/${sid}/prompt`, { text: TASKS[mode] });
  log('prompt accepted; waiting for the model (no timeout)');
  let raised = 0;
  let answered = 0;
  let heldClean = false;
  let handled = 0;
  for (;;) {
    while (handled < asks.length) {
      const ask = asks[handled];
      handled += 1;
      raised += 1;
      log(`${ask.kind} raised: ${JSON.stringify(ask.data).slice(0, 600)}`);
      if (raised === 1) {
        const before = await state('held, before the answer');
        log(`holding the turn for ${HOLD_MS} ms with no answer`);
        await sleep(HOLD_MS);
        const after = await state('held, after the wait');
        heldClean = before.files === after.files && !/approved\.txt|colour\.txt/.test(after.files) && after.pending > 0 && ended === null;
      }
      if (ask.kind === 'permission') {
        const body = mode === 'deny' ? { decision: 'reject', message: DENY_MESSAGE } : { decision: 'once' };
        log(`answering into the same turn: POST /api/session/{id}/permission/${ask.data.id}/reply ${JSON.stringify(body)}`);
        await api('POST', `/api/session/${sid}/permission/${encodeURIComponent(ask.data.id)}/reply`, body);
      } else {
        const body = { answer: formAnswer(ask.data) };
        log(`answering into the same turn: POST /api/session/{id}/form/${ask.data.id}/reply ${JSON.stringify(body)}`);
        await api('POST', `/api/session/${sid}/form/${encodeURIComponent(ask.data.id)}/reply`, body);
      }
      answered += 1;
    }
    if (ended && handled === asks.length) break;
    await signal();
  }
  await sleep(1000);
  const final = await state('after the turn');
  const approvedTxt = await ws.sh('cat approved.txt 2>/dev/null || true');
  const colourTxt = await ws.sh('cat colour.txt 2>/dev/null || true');
  const info = (await api('GET', `/api/session/${sid}`)).data;
  log(`execution ended with ${ended}; session outcome ${JSON.stringify(info.outcome)}`);
  log(`tools the model called: ${[...tools].join(', ')}`);
  log(`final text: ${JSON.stringify(finalText.slice(-300))}`);
  log(`approved.txt: ${JSON.stringify(approvedTxt)}; colour.txt: ${JSON.stringify(colourTxt)}`);
  record({ ended, finalText: finalText.slice(-300), approvedTxt, colourTxt, raised, answered, heldClean, tools: [...tools] });
  const ok = {
    approve: raised > 0 && heldClean && /yes/.test(approvedTxt),
    deny: raised > 0 && heldClean && !/approved\.txt/.test(final.files),
    question: raised > 0 && heldClean && colourTxt.includes(ANSWER),
  }[mode];
  verdict = ok ? 'PASS' : 'FAIL';
  log(`checks: raised ${raised}, answered ${answered}, held with nothing written ${heldClean}`);
} catch (e) {
  log(`probe threw ${e?.name}: ${String(e?.stack ?? e?.message ?? e).slice(0, 1500)}`);
  record({ thrown: e?.name, msg: String(e?.message ?? e).slice(0, 600) });
} finally {
  closer.abort();
  await proc?.cancel().catch(() => undefined);
  await ws.cleanup();
}
log(`RESULT opencode ${mode}: ${verdict}`);
record({ result: verdict });
await ev.close();
process.exit(verdict === 'PASS' ? 0 : 1);
