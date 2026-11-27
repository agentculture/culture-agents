/**
 * Contract 3.0: the shapes D2 part one adds. The schemas and fixtures are the source; these tests
 * check that the generated types and the validator carry them, and that the D1 guarantees hold.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  apiVersion,
  canTransition,
  errorCodes,
  exitCodeFor,
  httpStatusFor,
  isCompatible,
  isTerminal,
  retryableFor,
  runStates,
  validate,
  type AnswerRequest,
  type Capabilities,
  type ErrorBody,
  type Question,
  type Run,
  type RunEvent,
  type SchemaName,
  type SubmitResponse,
  type Submitter,
} from "../../src/contract/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "contract", "fixtures");
const read = <T>(path: string): T => JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as T;

/** Read a valid fixture through the validator, so the value has the generated type. */
function valid<T>(schema: SchemaName, path: string): T {
  const result = validate(schema, read<unknown>(`valid/${path}.json`));
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.issues));
  return result.value as T;
}

test("this core speaks API 3.0 and a 2.0 client is not compatible with it, in either direction", () => {
  assert.equal(apiVersion, "3.0");
  assert.equal(isCompatible("2.0", apiVersion), false);
  assert.equal(isCompatible(apiVersion, "2.0"), false);
  assert.equal(isCompatible("3.0", apiVersion), true);
  assert.equal(exitCodeFor("incompatible_version"), 2);
  const refusal = valid<{ error: ErrorBody }>("error", "error/root.incompatible-version").error;
  assert.deepEqual([refusal.client_api_version, refusal.server_api_version], ["2.0", "3.0"]);
});

test("a run carries who submitted it and the commit it starts from", () => {
  const run = valid<Run>("run", "run/root.running-with-submitter-and-base-commit");
  const submitter: Submitter | undefined = run.submitter;
  assert.deepEqual(submitter, { kind: "local_user", uid: 1000, user: "operator" });
  assert.match(run.base_commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(valid<Run>("run", "run/root.submitted-by-member").submitter?.kind, "member");
  // A 2.0-era run has neither field and is still a valid run.
  const old = valid<Run>("run", "run/root.running");
  assert.equal(old.submitter, undefined);
  assert.equal(old.base_commit, undefined);
});

test("no request shape can set the submitter or the base commit", () => {
  const request = read<Record<string, unknown>>("valid/control-action/submit_request.minimal.json");
  for (const field of ["submitter", "base_commit"]) {
    const result = validate("control-action#submit_request", { ...request, [field]: field === "submitter" ? { kind: "local_user", uid: 0 } : "0".repeat(40) });
    assert.equal(result.ok, false, field);
    if (!result.ok) assert.deepEqual([result.issues[0]?.keyword, result.issues[0]?.path], ["additionalProperties", `/${field}`]);
  }
});

test("the limit error names the limit, and the idempotency conflict names the key", () => {
  assert.ok(errorCodes.includes("limit_reached"));
  assert.deepEqual([httpStatusFor("limit_reached"), exitCodeFor("limit_reached"), retryableFor("limit_reached")], [429, 1, true]);
  const limit = valid<{ error: ErrorBody }>("error", "error/root.limit-reached").error;
  assert.equal(limit.code, "limit_reached");
  assert.deepEqual(limit.limit, { name: "runs_per_repository", value: 2, active: 2, repo: "/srv/repos/demo" });
  const conflict = valid<{ error: ErrorBody }>("error", "error/root.conflict-idempotency-key").error;
  assert.deepEqual([conflict.code, conflict.retryable, conflict.idempotency_key], ["conflict", false, "deploy-42"]);
  const retry = valid<{ error: ErrorBody }>("error", "error/root.unavailable-retry-shortly").error;
  assert.deepEqual([retry.code, retry.retryable, retry.retry_after_ms], ["unavailable", true, 500]);
});

test("a question and its answer are events, and the answer request names the question", () => {
  const asked = valid<RunEvent>("event", "event/root.question");
  assert.equal(asked.kind, "run.question");
  const question = (asked.data as { question: Question }).question;
  assert.deepEqual([question.kind, question.free_text, question.choices.length], ["question", true, 2]);
  const answered = valid<RunEvent>("event", "event/root.answer");
  assert.equal(answered.kind, "run.answer");
  assert.equal((answered.data as { question_id: string }).question_id, question.id);
  const request = valid<AnswerRequest>("control-action#answer_request", "control-action/answer_request.minimal");
  assert.equal(request.question_id, question.id);
  const waiting = valid<Run>("run", "run/root.waiting-for-answer");
  assert.deepEqual(waiting.pending_questions?.map((q) => q.id), [question.id]);
  assert.equal(waiting.state, "running", "a waiting run is running; there is no separate waiting state");
});

test("unanswered is a terminal state reached only through cancelling", () => {
  assert.ok(runStates.includes("unanswered"));
  assert.equal(isTerminal("unanswered"), true);
  for (const from of runStates) assert.equal(canTransition(from, "unanswered"), from === "cancelling", from);
  for (const to of runStates) assert.equal(canTransition("unanswered", to), false, to);
  assert.equal(valid<Run>("run", "run/root.unanswered").terminal, true);
});

test("a replayed submit may return a run that is no longer queued; a new one may not", () => {
  const replayed = valid<SubmitResponse>("control-action#submit_response", "control-action/submit_response.replayed");
  assert.equal(replayed.replayed, true);
  assert.notEqual(replayed.run.state, "queued");
  const fresh = { run: replayed.run };
  assert.equal(validate("control-action#submit_response", fresh).ok, false);
});

test("the capability report states limits, active runs and admission per signal", () => {
  const doc = valid<Capabilities>("capabilities", "capabilities/root.with-limits-and-admission");
  assert.deepEqual(doc.limits, { runs_per_repository: 2, runs_per_host: null });
  assert.equal(doc.active_runs, 1);
  assert.deepEqual([doc.admission?.heat.state, doc.admission?.gateway.consulted], ["hold", false]);
  for (const name of ["answer", "reconnect", "worktree_isolation"] as const) assert.equal(doc.capabilities[name].supported, true, name);
  // The capabilities D2 does not build stay pinned to unsupported by the schema. placement left this
  // list in t30 (part two builds it); contract/part-two-ready.test.ts covers it.
  for (const name of ["pause", "resume", "continue_session", "delegate"] as const) {
    const flipped = { ...doc, capabilities: { ...doc.capabilities, [name]: { supported: true, reason: null, caveats: [] } } };
    assert.equal(validate("capabilities", flipped).ok, false, name);
  }
});

test("D1 guarantee: an unsupported error names its capability", () => {
  assert.equal(validate("error", { error: { code: "unsupported", message: "no", retryable: false } }).ok, false);
  assert.equal(validate("error", { error: { code: "unsupported", message: "no", retryable: false, capability: "answer" } }).ok, true);
});

test("D1 guarantee: unknown is terminal and never leads to succeeded", () => {
  assert.equal(isTerminal("unknown"), true);
  for (const to of runStates) assert.equal(canTransition("unknown", to), false, to);
  for (const from of runStates.filter(isTerminal)) assert.equal(canTransition(from, "succeeded"), false, from);
});

test("the generated types name no vendor or AI SDK type", () => {
  const dir = join(here, "..", "..", "..", "src", "contract", "generated");
  const denied = ["ai-sdk", "aisdk", "@ai-sdk", "vercel", "openshell", "anthropic", "openai", "harnessagent", "harnessv1", "languagemodel", "uimessage"];
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8").toLowerCase();
    for (const word of denied) assert.ok(!text.includes(word), `${file} mentions ${word}`);
  }
});
