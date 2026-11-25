import { readFileSync, readdirSync } from "node:fs";

/** Base of every schema `$id` (api.json `schema_base`). An identifier only, never fetched. */
export const SCHEMA_BASE = "https://culture.dev/contract/agents/";

/**
 * Where the schema files live at run time: `dist/contract-schemas/`, populated from the
 * repo's `contract/` directory by the build (scripts/copy-contract-schemas.mjs) and shipped
 * in the npm package. Resolved relative to the compiled module, so it works from a checkout
 * and from an installed package alike. Override with `CULTURE_AGENTS_CONTRACT_DIR` (tests,
 * or running straight against `contract/`).
 */
export function schemaDir(): URL {
  const override = process.env["CULTURE_AGENTS_CONTRACT_DIR"];
  if (override) return new URL(`file://${override.replace(/\/?$/, "/")}`);
  return new URL("../../contract-schemas/", import.meta.url);
}

/** A parsed JSON Schema document. */
export type SchemaDocument = Record<string, unknown> & { $id: string };

/** Code-unit order: the order `sort()` uses when it is given no comparator. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Every schema file (all `contract/*.json` except the `api.json` index), by file name. */
export function loadSchemaFiles(dir: URL = schemaDir()): Map<string, SchemaDocument> {
  const out = new Map<string, SchemaDocument>();
  for (const file of readdirSync(dir).sort(byCodeUnit)) {
    if (!file.endsWith(".json") || file === "api.json") continue;
    out.set(file, JSON.parse(readFileSync(new URL(file, dir), "utf8")) as SchemaDocument);
  }
  return out;
}

/** Parse one JSON file from the schema directory (used for `api.json`). */
export function loadJson(file: string, dir: URL = schemaDir()): unknown {
  return JSON.parse(readFileSync(new URL(file, dir), "utf8"));
}
