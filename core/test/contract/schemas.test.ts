import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSchemaFiles, schemaDir } from "../../src/contract/index.js";

const repoContract = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contract");

test("the shipped schema directory is a byte-for-byte copy of contract/*.json", () => {
  const shipped = readdirSync(schemaDir()).sort();
  const source = readdirSync(repoContract).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(shipped, source);
  for (const file of source) {
    assert.equal(readFileSync(new URL(file, schemaDir()), "utf8"), readFileSync(join(repoContract, file), "utf8"), file);
  }
});

test("loadSchemaFiles returns every schema but not the api.json index", () => {
  const files = [...loadSchemaFiles().keys()];
  assert.ok(files.includes("run.json"));
  assert.ok(!files.includes("api.json"));
  for (const schema of loadSchemaFiles().values()) assert.match(schema.$id, /^https:\/\/culture\.dev\/contract\/agents\//);
});

test("the contract module imports nothing from the sandbox layer and names no vendor types", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "contract");
  const denied = ["ai-sdk", "aisdk", "openshell", "vercel", "anthropic", "openai", "harnessagent", "sandbox/"];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  const files = walk(src);
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const word of denied) assert.ok(!text.includes(word), `${file} mentions ${word}`);
  }
});
