/**
 * Remote control calls on the calling core (contract 3.2): one call to another fleet member over the
 * fleet transport, on behalf of the local operator's request on the control socket. The caller
 * chooses the member (the node of the agent id or run id); nothing schedules.
 *
 * A call goes only to a member that is listed now (it announced itself within the silence, under the
 * name the trust list gives its key) and only to an address of the local address list whose last
 * reply was authenticated as that member's key; the transport checks that key again on the call
 * (`expectNode`), so neither a name nor a stale address can reach another host. Then:
 *
 * - Version rule between cores (contract/README.md, "Calls between cores"): the member's announced
 *   MAJOR must equal this core's (else `incompatible_version`), and its MINOR must have the route
 *   (else `unsupported`, `placement`). The call carries this core's `Agents-Api-Version`.
 * - Every call has one timeout (5 s) and a cap on what it reads. A member that does not answer, or
 *   answers more than the cap, is `unavailable`: never a hang, and nothing is stored on this core.
 * - The member's answer is checked against the contract: the expected shape is returned, a typed
 *   error is relayed as that error (naming the member), anything else is `internal`.
 */
import type { KeyObject } from "node:crypto";

import { API_VERSION_HEADER, apiVersion, isPeerCompatible, servesSince, validate, type ErrorBody, type SchemaName } from "../contract/index.js";
import { ControlError, unavailable, unsupported } from "../daemon/errors.js";
import type { Members } from "./members.js";
import type { PeerAddress } from "./peers.js";
import { FLEET_TIMEOUT_MS, MAX_RESPONSE_BYTES, fleetCall, type FleetCallOptions, type FleetResponse } from "./transport.js";
import type { TrustList } from "./trust.js";

/** The MINOR that added remote runs: a member that announced less does not serve them. */
export const REMOTE_RUNS_SINCE = "3.2";

type Call = (o: FleetCallOptions) => Promise<FleetResponse>;

export interface RemoteOptions {
  key: KeyObject;
  /** This core's trust list, read again for each call. */
  trust: () => TrustList;
  members: Members;
  /** The address whose last reply was authenticated as `node` (announce.ts). */
  addressOf: (node: string) => PeerAddress | undefined;
  /** The API version this core speaks. Default: this build's; tests use an older MINOR. */
  apiVersion?: string;
  timeoutMs?: number;
  /** The transport call (tests inject one). */
  call?: Call;
}

export interface RemoteRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** The success status and the shape its body must have. */
  status: number;
  schema: SchemaName;
  /** Default: the transport's 1 MiB. */
  maxBytes?: number;
}

export interface Remote {
  /** This core's API version, as it sends it. */
  readonly apiVersion: string;
  /** One call to member `node`: the checked success body, or a `ControlError`. */
  request(node: string, r: RemoteRequest): Promise<unknown>;
}

function parsed(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The member's typed error, relayed with the member named in its message. */
function relayed(node: string, error: ErrorBody): ControlError {
  const { code, message, retryable, ...extras } = error;
  return new ControlError(code, `${node}: ${message}`.slice(0, 2000), { ...extras, retryable });
}

export function createRemote(o: RemoteOptions): Remote {
  const own = o.apiVersion ?? apiVersion;
  const call = o.call ?? fleetCall;

  /** The member's address once the version rule allows the call. */
  function target(node: string): PeerAddress {
    const member = o.members.view().members.find((m) => m.node === node);
    if (!member) throw unavailable(`${node} is not a listed fleet member: it has not announced itself to this core within the silence limit, or its key is not in this core's trust list.`);
    if (!isPeerCompatible(own, member.api_version)) {
      throw new ControlError("incompatible_version", `${node} speaks API ${member.api_version} and this core ${own}; cores call each other only within one MAJOR version.`, {
        client_api_version: own,
        server_api_version: member.api_version,
      });
    }
    if (!servesSince(member.api_version, REMOTE_RUNS_SINCE)) throw unsupported("placement", `${node} speaks API ${member.api_version}; runs on another member need API ${REMOTE_RUNS_SINCE} or later on that member. Upgrade it.`);
    const address = o.addressOf(node);
    if (!address) throw unavailable(`No address in this core's fleet address list (peers.json) has answered as ${node}; add its address there.`);
    return address;
  }

  return {
    apiVersion: own,
    async request(node, r) {
      const address = target(node);
      let res: FleetResponse;
      try {
        res = await call({
          key: o.key,
          trust: o.trust(),
          host: address.host,
          port: address.port,
          method: r.method,
          path: r.path,
          ...(r.body !== undefined && { body: JSON.stringify(r.body) }),
          expectNode: node,
          headers: { [API_VERSION_HEADER]: own },
          timeoutMs: o.timeoutMs ?? FLEET_TIMEOUT_MS,
          maxResponseBytes: r.maxBytes ?? MAX_RESPONSE_BYTES,
        });
      } catch (e) {
        throw unavailable(`${node} did not answer: ${(e as Error).message}`.slice(0, 2000));
      }
      const body = parsed(res.body);
      if (res.status === r.status && validate(r.schema, body).ok) return body;
      const error = validate("error", body);
      if (error.ok) throw relayed(node, error.value.error);
      throw new ControlError("internal", `${node} answered HTTP ${res.status} with a body that does not match the contract.`);
    },
  };
}
