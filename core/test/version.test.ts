import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { version } from "../src/index.js";

test("version export matches package.json", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(version, manifest.version);
});
