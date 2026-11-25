#!/usr/bin/env node
// Copies the contract JSON Schemas (and api.json) from the repo's contract/ directory into
// dist/contract-schemas/ so they ship inside the npm package. Fixtures and the README are
// not copied. The files are copied verbatim, never re-serialized.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "contract");
const to = join(here, "..", "dist", "contract-schemas");

mkdirSync(to, { recursive: true });
for (const file of readdirSync(from)) {
  if (file.endsWith(".json")) copyFileSync(join(from, file), join(to, file));
}
