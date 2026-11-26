/**
 * The store schema version. 3.0 writes `store.json` (`{"schema": N}`) into every run directory.
 * A directory without it was written by 2.0 and is read as version 0: the same files, no version.
 * A directory written under a newer schema than this code knows is not read (it is unreadable,
 * never guessed at), so an older core cannot misreport a newer store.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { FILE_MODE, runFile } from "./files.js";

/** The schema this code writes. Bump it when a stored shape changes incompatibly. */
export const STORE_SCHEMA_VERSION = 1;

export class StoreVersionError extends Error {
  override readonly name = "StoreVersionError";
}

export function writeStoreVersion(dir: string): void {
  writeFileSync(runFile(dir, "version"), `${JSON.stringify({ schema: STORE_SCHEMA_VERSION })}\n`, { mode: FILE_MODE, flag: "wx" });
}

/** The directory's schema version: 0 when it has none (written by 2.0). Throws `StoreVersionError` when the file is not a version. */
export function readStoreVersion(dir: string): number {
  let text: string;
  try {
    text = readFileSync(runFile(dir, "version"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let schema: unknown;
  try {
    schema = (JSON.parse(text) as { schema?: unknown }).schema;
  } catch {
    throw new StoreVersionError("the store version file is not valid JSON");
  }
  if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1) throw new StoreVersionError("the store version file holds no schema number");
  return schema;
}

/** Throws unless this code can read the directory's schema. */
export function assertReadableVersion(dir: string): void {
  const schema = readStoreVersion(dir);
  if (schema > STORE_SCHEMA_VERSION) {
    throw new StoreVersionError(`the run directory uses store schema ${schema}; this core reads schema ${STORE_SCHEMA_VERSION} and earlier`);
  }
}
