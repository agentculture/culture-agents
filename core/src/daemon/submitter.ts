import { statSync } from "node:fs";
import { userInfo } from "node:os";

import type { Submitter } from "../contract/index.js";

/**
 * Who submitted a run over the control socket, as the core established it (contract/README.md:
 * authorization). Node cannot read a connection's peer credentials and this core adds no native
 * module, so the local submitter is the user that owns the socket file: the socket is 0600 inside a
 * 0700 directory, so only that user can connect. The value is read once from the bound socket and
 * never from a request.
 */
export function socketSubmitter(socketPath: string): Submitter {
  const uid = statSync(socketPath).uid;
  const submitter: Submitter = { kind: "local_user", uid };
  try {
    const info = userInfo();
    if (info.uid === uid) submitter.user = info.username;
  } catch {
    /* the account name is optional */
  }
  return submitter;
}
