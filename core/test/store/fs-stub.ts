/**
 * Replace one `node:fs` function for a test, so a read or write can fail the way a loaded host
 * makes it fail (EMFILE, ENOSPC, EIO). `syncBuiltinESMExports` makes the replacement visible to
 * modules that imported the function by name. Restored after the test, or by the returned function.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

type Stubbable = "readFileSync" | "writeSync" | "fsyncSync" | "ftruncateSync";

export function errno(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated failure, ${syscall}`), { code, syscall });
}

export function stubFs<K extends Stubbable>(t: TestContext, name: K, make: (real: (typeof fs)[K]) => (typeof fs)[K]): () => void {
  const real = fs[name];
  const set = (fn: (typeof fs)[K]): void => {
    (fs as Record<K, (typeof fs)[K]>)[name] = fn;
    syncBuiltinESMExports();
  };
  set(make(real));
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    set(real);
  };
  t.after(restore);
  return restore;
}
