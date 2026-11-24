/**
 * Shared contract module: types, validation and small rules for the control-plane API.
 * Types are generated from contract/*.json (`npm run gen:contract`); validation reads the
 * same schema files. See contract/README.md for the semantics.
 */
export * from "./generated/index.js";
export { SCHEMA_BASE, loadSchemaFiles, schemaDir } from "./schemas.js";
export type { SchemaDocument } from "./schemas.js";
export { ContractValidationError } from "./errors.js";
export type { ValidationIssue } from "./errors.js";
export { assertValid, schemaNames, validate } from "./validate.js";
export type { SchemaName, ValidationResult } from "./validate.js";
export {
  API_VERSION_HEADER,
  apiVersion,
  errorCodes,
  exitCodeFor,
  httpStatusFor,
  isCompatible,
  parseApiVersion,
  retryableFor,
} from "./api.js";
export type { ApiVersion } from "./api.js";
export { canTransition, initialState, isActive, isTerminal, nextStates, runStates } from "./run-state.js";
export {
  buildActionId,
  buildMeshId,
  buildRunId,
  buildSessionId,
  isActionId,
  isRunId,
  isSessionId,
  newUlid,
  parseMeshId,
  parseScopedId,
  runBranch,
} from "./ids.js";
export type { MeshIdParts, ScopedIdParts, ScopedKind } from "./ids.js";
