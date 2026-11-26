// Can Claude Code, driven through the AI SDK adapter, ask its operator and wait?
//
//   node claude-probe.mjs <approve|deny|question> [permissionMode]
//
// approve   permissionMode allow-reads (default). The task needs a Write; the adapter must raise
//           a tool-approval-request, the turn must hold with nothing written, and one approval
//           delivered with continueStream must let the SAME turn write the file.
// deny      same, but the answer is a denial with a reason; the file must not exist and the
//           model must see the reason.
// question  the model is told to ask the operator a question (Claude Code's AskUserQuestion,
//           the adapter's `askUserQuestions`); one free-text answer goes back with
//           continueStream and must end up in a file.
//
// Calls used (all from @ai-sdk/harness 1.0.192, the version pinned in core/package.json):
//   new HarnessAgent({ permissionMode })            anything but 'allow-all'
//   agent.stream({ session, prompt })               ends when the turn is waiting on the host
//   agent.continueStream({ session, toolApprovalContinuations | toolResultContinuations })
// Evidence: evidence/claude-<mode>[-<permissionMode>][$PROBE_TAG].ndjson and the stdout log.
import { evidence, HOLD_MS, coreImport, openWorkspace, runId, sleep } from './common.mjs';

const [mode = 'approve', permissionMode = 'allow-reads'] = process.argv.slice(2);
const TASKS = {
  approve: 'Create a file named approved.txt containing the single word yes, using your Write tool. Then reply with the single word done.',
  deny: 'Create a file named approved.txt containing the single word yes, using your Write tool. If you are not allowed to, do not try any other way: reply with the exact reason you were given.',
  question:
    'Before doing anything else, ask the operator which colour to use: call the AskUserQuestion tool once with the question ' +
    '"Which colour should I use?" and the options red and green. Then create a file named colour.txt containing only the ' +
    "operator's answer, using your Write tool, and reply with the single word done.",
};
if (!TASKS[mode]) throw new Error('usage: claude-probe.mjs <approve|deny|question> [allow-reads|allow-edits|allow-all]');
const DENY_REASON = 'The operator said no: probe-denial-7341.';
const ANSWER = 'ultraviolet-7341';

const { HarnessAgent } = await coreImport('node_modules/@ai-sdk/harness/dist/agent/index.js');
const { createClaudeCode } = await coreImport('node_modules/@ai-sdk/harness-claude-code/dist/index.js');
const { toHarnessSandboxSession } = await coreImport('dist/src/sandbox/harness-session.js');

const ev = evidence(`claude-${mode}${permissionMode === 'allow-reads' ? '' : `-${permissionMode}`}${process.env.PROBE_TAG ?? ''}`);
const { log, record } = ev;
const id = runId(`cc${mode[0]}`);
const ws = await openWorkspace(id, (c) => c.claudeCode.providers, log);
let verdict = 'FAIL';
try {
  const agent = new HarnessAgent({
    harness: createClaudeCode({ auth: {} }),
    model: ws.config.claudeCode.model,
    permissionMode,
    sandboxConfig: { workDir: ws.workspace.relativeWorkdir },
    onLog: (d) => record({ diag: d.level, msg: String(d.message).slice(0, 300) }),
  });
  log(`createSession, model ${ws.config.claudeCode.model}, permissionMode ${permissionMode}`);
  const session = await agent.createSession({ sessionId: id, sandboxSession: toHarnessSandboxSession(ws.workspace.sandbox) });

  let finalText = '';
  /** Consume one stream; return what the turn is now waiting for. */
  const consume = async (result) => {
    const waiting = { approvals: [], questions: [] };
    const calls = new Map();
    let finish;
    for await (const part of result.fullStream) {
      const brief = { type: part.type };
      if (part.type === 'text-delta') finalText += part.text ?? part.delta ?? '';
      if (part.type === 'tool-call') {
        calls.set(part.toolCallId, part);
        brief.tool = part.toolName;
        brief.toolCallId = part.toolCallId;
        brief.providerExecuted = part.providerExecuted;
        brief.input = JSON.stringify(part.input).slice(0, 400);
        log(`tool-call ${part.toolName} ${brief.input.slice(0, 160)}`);
        if (part.toolName === 'askUserQuestions') waiting.questions.push(part);
      }
      if (part.type === 'tool-approval-request') {
        brief.approvalId = part.approvalId;
        brief.toolCallId = part.toolCall?.toolCallId ?? part.toolCallId;
        brief.tool = part.toolCall?.toolName ?? calls.get(brief.toolCallId)?.toolName;
        log(`tool-approval-request ${brief.approvalId} for ${brief.tool}`);
        waiting.approvals.push(brief);
      }
      if (part.type === 'tool-result') {
        brief.tool = part.toolName;
        brief.toolCallId = part.toolCallId;
        brief.output = JSON.stringify(part.output ?? part.result ?? null).slice(0, 300);
        log(`tool-result ${part.toolName} ${brief.output.slice(0, 160)}`);
        const i = waiting.questions.findIndex((q) => q.toolCallId === part.toolCallId);
        if (i >= 0) waiting.questions.splice(i, 1);
      }
      if (part.type === 'tool-error') brief.error = String(part.error?.message ?? part.error).slice(0, 300);
      if (part.type === 'error') {
        brief.error = String(part.error?.message ?? part.error).slice(0, 300);
        log(`error part: ${brief.error}`);
      }
      if (part.type === 'finish') {
        brief.finishReason = part.finishReason;
        finish = part.finishReason;
      }
      if (part.type !== 'text-delta' && part.type !== 'reasoning-delta') record(brief);
    }
    log(`stream ended: finishReason ${JSON.stringify(finish)}, session.turnState ${session.turnState}, ` +
      `${waiting.approvals.length} approval(s) and ${waiting.questions.length} question(s) pending`);
    record({ streamEnded: true, finish, turnState: session.turnState, approvals: waiting.approvals.length, questions: waiting.questions.length });
    return waiting;
  };

  const state = async (label) => {
    const files = await ws.sh('ls -1 | tr "\\n" " "');
    const procs = await ws.sh('ps -eo args | grep -c "[c]laude" || true');
    log(`${label}: files [${files.trim()}], claude processes in sandbox ${procs}`);
    record({ state: label, files: files.trim(), claudeProcesses: Number(procs) });
    return files;
  };

  let raised = 0;
  let answered = 0;
  let heldClean = false;
  let waiting = await consume(await agent.stream({ session, prompt: TASKS[mode] }));
  for (let round = 0; waiting.approvals.length + waiting.questions.length > 0; round += 1) {
    if (round > 6) throw new Error('more than 6 rounds of host input; giving up');
    raised += waiting.approvals.length + waiting.questions.length;
    if (round === 0) {
      const before = await state('held, before the answer');
      log(`holding the turn for ${HOLD_MS} ms with no answer`);
      await sleep(HOLD_MS);
      const after = await state('held, after the wait');
      heldClean = before === after && !/approved\.txt|colour\.txt/.test(after) && session.turnState !== 'idle';
    }
    const toolApprovalContinuations = waiting.approvals.map((a) => ({
      type: 'tool-approval-response',
      approvalId: a.approvalId,
      approved: mode !== 'deny',
      ...(mode === 'deny' ? { reason: DENY_REASON } : {}),
    }));
    const toolResultContinuations = waiting.questions.map((q) => ({
      type: 'tool-result',
      toolCallId: q.toolCallId,
      toolName: 'askUserQuestions',
      output: {
        type: 'json',
        value: { action: 'answered', answers: Object.fromEntries((q.input?.questions ?? []).map((x) => [x.id, { optionIds: [], freeform: ANSWER }])) },
      },
    }));
    answered += toolApprovalContinuations.length + toolResultContinuations.length;
    record({ answer: { toolApprovalContinuations, toolResultContinuations } });
    log(`answering into the same turn: ${JSON.stringify({ toolApprovalContinuations, toolResultContinuations }).slice(0, 400)}`);
    waiting = await consume(await agent.continueStream({ session, toolApprovalContinuations, toolResultContinuations }));
  }

  const files = await state('after the turn');
  const approvedTxt = await ws.sh('cat approved.txt 2>/dev/null || true');
  const colourTxt = await ws.sh('cat colour.txt 2>/dev/null || true');
  log(`final text: ${JSON.stringify(finalText.slice(-300))}`);
  log(`approved.txt: ${JSON.stringify(approvedTxt)}; colour.txt: ${JSON.stringify(colourTxt)}`);
  record({ finalText: finalText.slice(-300), approvedTxt, colourTxt, raised, answered, heldClean });
  const ok = {
    approve: raised > 0 && heldClean && /yes/.test(approvedTxt),
    deny: raised > 0 && heldClean && !/approved\.txt/.test(files) && /7341/.test(finalText),
    question: raised > 0 && heldClean && colourTxt.includes(ANSWER),
  }[mode];
  verdict = ok ? 'PASS' : 'FAIL';
  log(`checks: raised ${raised}, answered ${answered}, held with nothing written ${heldClean}`);
  await session.destroy().catch((e) => log(`session.destroy: ${e?.message ?? e}`));
} catch (e) {
  log(`probe threw ${e?.name}: ${String(e?.stack ?? e?.message ?? e).slice(0, 1500)}`);
  record({ thrown: e?.name, msg: String(e?.message ?? e).slice(0, 600) });
} finally {
  await ws.cleanup();
}
log(`RESULT claude-code ${mode} (${permissionMode}): ${verdict}`);
record({ result: verdict });
await ev.close();
process.exit(verdict === 'PASS' ? 0 : 1);
