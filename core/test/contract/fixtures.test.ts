import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canTransition, isTerminal, validate, type AnswerData, type QuestionData, type RunState, type SchemaName } from "../../src/contract/index.js";

// dist/test/contract -> repo root is four levels up.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract", "fixtures");

/** `fixtures/<kind>/<stem>/<target>.<label>.json` -> schema name, as tests/contract_support.py does. */
function targetOf(path: string): SchemaName {
  const stem = basename(dirname(path));
  const target = basename(path).split(".", 1)[0];
  return (target === "root" ? stem : `${stem}#${target}`) as SchemaName;
}

function fixtureFiles(kind: "valid" | "invalid"): string[] {
  const out: string[] = [];
  for (const stem of readdirSync(join(FIXTURES, kind)).sort()) {
    for (const file of readdirSync(join(FIXTURES, kind, stem)).sort()) {
      if (file.endsWith(".json")) out.push(join(FIXTURES, kind, stem, file));
    }
  }
  return out;
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const rel = (path: string): string => path.slice(FIXTURES.length + 1);

const valid = fixtureFiles("valid");
const invalid = fixtureFiles("invalid");

test("fixture discovery finds fixtures", () => {
  assert.ok(valid.length > 0, "no valid fixtures found");
  assert.ok(invalid.length > 0, "no invalid fixtures found");
});

for (const path of valid) {
  test(`valid fixture validates: ${rel(path)}`, () => {
    const result = validate(targetOf(path), read(path));
    assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.issues));
  });
}

for (const path of invalid) {
  test(`invalid fixture is rejected: ${rel(path)}`, () => {
    const result = validate(targetOf(path), read(path));
    assert.equal(result.ok, false);
  });
}

// --- event streams (README: Events, cursor and replay) ---------------------------------

function streamProblems(lines: unknown[]): string[] {
  const problems: string[] = [];
  const runIds = new Set(lines.map((l) => (l as { run_id?: unknown }).run_id));
  if (runIds.size !== 1) problems.push("stream mixes run ids");
  let state: RunState | null = null;
  const pending = new Set<string>();
  lines.forEach((event, i) => {
    const index = i + 1;
    const checked = validate("event", event);
    if (!checked.ok) {
      problems.push(`event ${index} invalid`);
      return;
    }
    const e = checked.value;
    if (e.cursor !== index) problems.push(`event ${index} has cursor ${e.cursor}`);
    if (state !== null && isTerminal(state)) problems.push(`event ${index} follows terminal state`);
    if (e.kind === "run.state") {
      const data = e.data as { from: RunState | null; to: RunState };
      if (data.from !== state) problems.push(`event ${index} from mismatch`);
      if (!canTransition(state, data.to)) problems.push(`event ${index} illegal transition`);
      state = data.to;
    } else if (index === 1) {
      problems.push("first event must be run.state");
    } else if (e.kind === "run.question") {
      pending.add((e.data as QuestionData).question.id);
    } else if (e.kind === "run.answer") {
      // An answer names a question that is pending, and a question takes one answer.
      if (!pending.delete((e.data as AnswerData).question_id)) problems.push(`event ${index} answers no pending question`);
    }
  });
  return problems;
}

function streamFiles(kind: "valid" | "invalid"): string[] {
  const dir = join(FIXTURES, "streams", kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(dir, f));
}

const lines = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

for (const path of streamFiles("valid")) {
  test(`valid stream obeys the stream rules: ${basename(path)}`, () => {
    assert.deepEqual(streamProblems(lines(path)), []);
  });
}

for (const path of streamFiles("invalid")) {
  test(`invalid stream breaks a stream rule: ${basename(path)}`, () => {
    assert.notDeepEqual(streamProblems(lines(path)), []);
  });
}
