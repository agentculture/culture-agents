#!/usr/bin/env node
// Generates TypeScript types from the contract JSON Schemas (contract/*.json).
//
//   node scripts/gen-contract-types.mjs          write src/contract/generated/
//   node scripts/gen-contract-types.mjs --check  exit 1 if the checked-in output is stale
//
// The generator understands exactly the keyword subset the contract uses
// ($ref, type, const, enum, properties/required, items, anyOf/oneOf, and the
// kind-discriminated allOf/if/then pattern). Conditional constraints (if/then/else
// on values) are validation-only and are not represented in types; the runtime
// validator (ajv) is the authority for those. An unknown shape throws, so a schema
// change the generator cannot express fails loudly instead of drifting silently.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, "..", "..", "contract");
const outDir = join(here, "..", "src", "contract", "generated");

const pascal = (s) =>
  s
    .split(/[-_.]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");

// Names that would collide with a global or another type if derived mechanically.
const ROOT_NAMES = { "error.json": "ErrorResponse", "event.json": "RunEvent", "fleet.json": "MemberList", "remote.json": "RemoteRun", "unreadable.json": "UnreadableRunList", "reachability.json": "RunView" };
const DEF_NAMES = {
  "common.json#node": "MeshNode",
  "common.json#text": "CallerText",
  "error.json#error": "ErrorBody",
  "error.json#code": "ErrorCode",
  "event.json#kind": "EventKind",
  "run.json#state": "RunState",
  "remote.json#alias": "RepoAlias",
  "remote.json#submit_request": "RemoteSubmitRequest",
  "remote.json#submit_response": "RemoteSubmitResponse",
};

const stemOf = (file) => file.replace(/\.json$/, "");

/** Code-unit order (what a bare `sort()` gives strings), so the output never depends on a locale. */
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function loadSchemas() {
  const schemas = new Map();
  for (const file of readdirSync(contractDir).sort(byCodeUnit)) {
    if (!file.endsWith(".json") || file === "api.json") continue;
    schemas.set(file, JSON.parse(readFileSync(join(contractDir, file), "utf8")));
  }
  return schemas;
}

function typeName(file, def) {
  if (def === null) return ROOT_NAMES[file] ?? pascal(stemOf(file));
  return DEF_NAMES[`${file}#${def}`] ?? pascal(def);
}

const lit = (v) => JSON.stringify(v);
const doc = (text, indent) =>
  text ? `${indent}/** ${String(text).replace(/\s+/g, " ").replaceAll("*/", "* /")} */\n` : "";

function resolvePointer(schema, pointer) {
  let node = schema;
  for (const part of pointer.split("/").slice(1)) node = node?.[part];
  if (node === undefined) throw new Error(`unresolvable pointer ${pointer}`);
  return node;
}

function makeContext(schemas, file, imports) {
  const refType = (ref) => {
    const [target, pointer = ""] = ref.split("#");
    const targetFile = target === "" ? file : target;
    const schema = schemas.get(targetFile);
    if (!schema) throw new Error(`${file}: $ref to unknown file ${ref}`);
    if (pointer === "") return use(targetFile, null);
    const m = /^\/\$defs\/([^/]+)$/.exec(pointer);
    if (m) return use(targetFile, m[1]);
    // Pointer into a property: inline that property's type.
    return render(resolvePointer(schema, pointer), 0, makeContext(schemas, targetFile, imports));
  };
  const use = (targetFile, def) => {
    const name = typeName(targetFile, def);
    if (targetFile !== file) {
      if (!imports.has(targetFile)) imports.set(targetFile, new Set());
      imports.get(targetFile).add(name);
    }
    return name;
  };
  return { refType };
}

const NOISE = new Set([
  "$schema", "$id", "$defs", "title", "description", "$comment", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "if", "then", "else", "not",
]);

function render(node, depth, ctx) {
  const parts = [];
  const rest = { ...node };
  if (node.$ref) {
    parts.push(ctx.refType(node.$ref));
    delete rest.$ref;
    const meaningful = Object.keys(rest).filter((k) => !NOISE.has(k) && k !== "allOf");
    if (meaningful.length === 0) return parts[0];
  }
  if ("const" in rest) parts.push(lit(rest.const));
  else if (rest.enum) parts.push(rest.enum.map(lit).join(" | "));
  else if (rest.anyOf || rest.oneOf) {
    parts.push((rest.anyOf ?? rest.oneOf).map((n) => render(n, depth, ctx)).join(" | "));
  } else if (Array.isArray(rest.type)) {
    parts.push(rest.type.map((t) => render({ ...rest, type: t }, depth, ctx)).join(" | "));
  } else if (rest.type === "array") {
    parts.push(`${wrap(render(rest.items ?? {}, depth, ctx))}[]`);
  } else if (rest.type === "object" || rest.properties) {
    parts.push(renderObject(rest, depth, ctx));
  } else if (rest.type) {
    const prim = { string: "string", integer: "number", number: "number", boolean: "boolean", null: "null" };
    if (!prim[rest.type]) throw new Error(`unsupported type ${rest.type}`);
    parts.push(prim[rest.type]);
  } else if (!node.$ref) {
    parts.push("unknown");
  }
  return parts.length === 1 ? parts[0] : parts.map(wrap).join(" & ");
}

const wrap = (t) => (/[|&]/.test(t) && !/^\(.*\)$/.test(t) ? `(${t})` : t);

// allOf of `if: {properties: {k: {const: V}}}, then: {properties: {...}}` (no else)
// becomes a discriminated union. Values of `k` that no branch names are not constrained by the
// schema, so the union gets one extra variant for them (`k` excluding every named value);
// without it the type would reject valid payloads (e.g. an Agent in state `unavailable`).
// Anything else under allOf is validation-only.
function discriminated(node, depth, ctx) {
  const branches = (node.allOf ?? []).filter((b) => b.if?.properties && b.then?.properties && !b.else);
  if (branches.length === 0 || branches.length !== node.allOf.length) return null;
  const keys = new Set(branches.map((b) => Object.keys(b.if.properties)[0]));
  const variants = branches.map((b) => {
    const [[key, cond]] = Object.entries(b.if.properties);
    return `{ ${key}: ${lit(cond.const)} } & ${renderObject({ properties: b.then.properties }, depth, ctx, false)}`;
  });
  if (keys.size === 1) {
    const [key] = keys;
    const named = branches.map((b) => lit(b.if.properties[key].const)).join(" | ");
    const own = node.properties?.[key];
    const rest = own ? `Exclude<${render(own, depth, ctx)}, ${named}>` : "never";
    variants.push(`{ ${key}: ${rest} }`);
  }
  return variants.map((v) => `(${v})`).join(" | ");
}

function renderObject(node, depth, ctx, closedCheck = true) {
  const props = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const entries = Object.entries(props);
  if (entries.length === 0) {
    if (closedCheck && node.additionalProperties === false) return "Record<string, never>";
    return "Record<string, unknown>";
  }
  const pad = "  ".repeat(depth + 1);
  const lines = entries.map(([key, sub]) => {
    const opt = required.has(key) || !closedCheck ? "" : "?";
    const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : lit(key);
    return `${doc(sub.description, pad)}${pad}${k}${opt}: ${render(sub, depth + 1, ctx)};`;
  });
  let out = `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  const disc = closedCheck ? discriminated(node, depth, ctx) : null;
  if (disc) out += ` & (${disc})`;
  return out;
}

export function generate() {
  const schemas = loadSchemas();
  const files = new Map();
  const seen = new Map();
  const schemaTypes = [];
  const indexExports = [];
  for (const [file, schema] of schemas) {
    const imports = new Map();
    const ctx = makeContext(schemas, file, imports);
    const decls = [];
    const declare = (def, node) => {
      const name = typeName(file, def);
      if (seen.has(name)) throw new Error(`type name ${name} produced by ${seen.get(name)} and ${file}`);
      seen.set(name, file);
      decls.push(`${doc(node.description ?? node.title, "")}export type ${name} = ${render(node, 0, ctx)};\n`);
      const key = def === null ? stemOf(file) : `${stemOf(file)}#${def}`;
      schemaTypes.push([key, name, file]);
      indexExports.push([file, name]);
    };
    declare(null, schema);
    for (const [def, node] of Object.entries(schema.$defs ?? {})) declare(def, node);
    const importLines = [...imports]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, names]) => `import type { ${[...names].sort(byCodeUnit).join(", ")} } from "./${stemOf(f)}.js";`);
    const header = `// GENERATED by core/scripts/gen-contract-types.mjs from contract/${file}. Do not edit.\n`;
    files.set(`${stemOf(file)}.ts`, `${header}\n${importLines.join("\n")}${importLines.length ? "\n\n" : ""}${decls.join("\n")}`);
  }
  const byFile = new Map();
  for (const [file, name] of indexExports) byFile.set(file, [...(byFile.get(file) ?? []), name]);
  const exportLines = [...byFile].map(([f, names]) => `export type { ${names.join(", ")} } from "./${stemOf(f)}.js";`);
  const importAll = [...byFile].map(([f, names]) => `import type { ${names.join(", ")} } from "./${stemOf(f)}.js";`);
  const mapLines = schemaTypes.map(([key, name]) => `  ${lit(key)}: ${name};`);
  files.set(
    "index.ts",
    `// GENERATED by core/scripts/gen-contract-types.mjs from contract/*.json. Do not edit.\n\n` +
      `${importAll.join("\n")}\n\n${exportLines.join("\n")}\n\n` +
      `/** Schema target (\`<file stem>\` or \`<file stem>#<$defs name>\`) to its payload type. */\n` +
      `export interface SchemaTypes {\n${mapLines.join("\n")}\n}\n`,
  );
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const files = generate();
  let stale = 0;
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of files) {
    const path = join(outDir, name);
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
    if (current === content) continue;
    stale += 1;
    if (check) process.stderr.write(`stale: src/contract/generated/${name}\n`);
    else writeFileSync(path, content);
  }
  const extra = readdirSync(outDir).filter((f) => !files.has(f));
  for (const f of extra) {
    stale += 1;
    process.stderr.write(`unexpected: src/contract/generated/${f}\n`);
  }
  if (check && stale > 0) {
    process.stderr.write("run `npm run gen:contract` in core/\n");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
