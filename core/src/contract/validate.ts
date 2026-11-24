import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { ContractValidationError, type ValidationIssue } from "./errors.js";
import type { SchemaTypes } from "./generated/index.js";
import { SCHEMA_BASE, loadSchemaFiles } from "./schemas.js";

/** A validation target: `<file stem>` (the file's root schema) or `<file stem>#<$defs name>`. */
export type SchemaName = keyof SchemaTypes;

export type ValidationResult<N extends SchemaName> =
  | { ok: true; value: SchemaTypes[N] }
  | { ok: false; issues: ValidationIssue[] };

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  // allErrors so a caller sees every violation; strict stays on except for the layered if/then subschemas, which
  // deliberately omit `type` (constraints on an already-typed object).
  const created = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  for (const schema of loadSchemaFiles().values()) created.addSchema(schema);
  ajv = created;
  return created;
}

function targetRef(name: string): string {
  const [stem, def] = name.split("#");
  return `${SCHEMA_BASE}${stem}.json${def === undefined ? "" : `#/$defs/${def}`}`;
}

function validatorFor(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    fn = instance().compile({ $ref: targetRef(name) });
    compiled.set(name, fn);
  }
  return fn;
}

// Combinator keywords restate a failure found deeper; list the specific issues first.
const WRAPPERS = new Set(["if", "not", "anyOf", "oneOf", "allOf"]);

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  const ordered = [...(errors ?? [])].sort((a, b) => Number(WRAPPERS.has(a.keyword)) - Number(WRAPPERS.has(b.keyword)));
  return ordered.map((e) => {
    let path = e.instancePath;
    if (e.keyword === "required") path += `/${String((e.params as { missingProperty: string }).missingProperty)}`;
    if (e.keyword === "additionalProperties") path += `/${String((e.params as { additionalProperty: string }).additionalProperty)}`;
    return { path, keyword: e.keyword, message: e.message ?? "invalid" };
  });
}

/** Validate `value` against a contract schema target, returning the typed value or the issues. */
export function validate<N extends SchemaName>(name: N, value: unknown): ValidationResult<N> {
  const fn = validatorFor(name);
  if (fn(value)) return { ok: true, value: value as SchemaTypes[N] };
  return { ok: false, issues: toIssues(fn.errors) };
}

/** Like `validate`, but throws `ContractValidationError` (code `invalid`, with the failing path). */
export function assertValid<N extends SchemaName>(name: N, value: unknown): SchemaTypes[N] {
  const result = validate(name, value);
  if (!result.ok) throw new ContractValidationError(name, result.issues);
  return result.value;
}

/** Every validation target, in schema order. */
export function schemaNames(): SchemaName[] {
  const names: string[] = [];
  for (const [file, schema] of loadSchemaFiles()) {
    const stem = file.replace(/\.json$/, "");
    names.push(stem);
    for (const def of Object.keys((schema["$defs"] as Record<string, unknown> | undefined) ?? {})) names.push(`${stem}#${def}`);
  }
  return names as SchemaName[];
}
