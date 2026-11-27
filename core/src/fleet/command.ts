#!/usr/bin/env node
/**
 * `culture-agents-fleet`: the operator's two steps for a fleet member (docs/d2/part-two-design.md).
 *
 * - `keygen` prints a new private key in its one-line form, for the operator to store in grant
 *   (`culture-agents-fleet keygen | grant set ...`). It is the only output of this repository that
 *   holds a private key; never paste it into a file that is tracked or shared.
 * - `cert [--node <name>]` reads `CULTURE_AGENTS_FLEET_KEY` (run it under `grant run --inject`) and
 *   prints the trust-list entry other members add, `{ "node", "cert" }`, and the SHA-256
 *   fingerprint of the public key to compare by eye. Both are public. The node name defaults to
 *   `server.name` in the local server.yaml.
 *
 * Exit codes: 0 done, 2 the key is missing or invalid, or the arguments are wrong.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readNodeName } from "../daemon/main.js";
import { certificateFor, FLEET_KEY_ENV, fingerprint, fleetKeyText, newFleetKey, parseFleetKey } from "./cert.js";

type Write = (text: string) => void;

const USAGE = "usage: culture-agents-fleet keygen | culture-agents-fleet cert [--node <name>]";

function cert(args: readonly string[], env: Record<string, string | undefined>, out: Write, err: Write): number {
  const node = args[0] === "--node" ? args[1] : readNodeName(env);
  if (args.length > 0 && (args[0] !== "--node" || args.length !== 2)) {
    err(`${USAGE}\n`);
    return 2;
  }
  if (!node || !/^[a-z0-9]{1,32}$/.test(node)) {
    err("culture-agents-fleet: no valid node name; pass --node <name> or set server.name in server.yaml\n");
    return 2;
  }
  const text = env[FLEET_KEY_ENV];
  if (!text) {
    err(`culture-agents-fleet: ${FLEET_KEY_ENV} is not set; run this under grant run --inject\n`);
    return 2;
  }
  try {
    const key = parseFleetKey(text);
    const printed = { entry: { node, cert: certificateFor(key).text }, fingerprint: "sha256:" + fingerprint(key) };
    out(JSON.stringify(printed) + "\n");
    return 0;
  } catch (e) {
    err(`culture-agents-fleet: ${(e as Error).message}\n`); // the message never holds the key
    return 2;
  }
}

/** Run one command; returns the exit code. */
export function run(argv: readonly string[], env: Record<string, string | undefined> = process.env, out: Write = (t) => process.stdout.write(t), err: Write = (t) => process.stderr.write(t)): number {
  const [verb, ...rest] = argv;
  if (verb === "keygen" && rest.length === 0) {
    out(`${fleetKeyText(newFleetKey())}\n`);
    return 0;
  }
  if (verb === "cert") return cert(rest, env, out, err);
  err(`${USAGE}\n`);
  return 2;
}

function isBinTarget(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isBinTarget()) process.exitCode = run(process.argv.slice(2));
